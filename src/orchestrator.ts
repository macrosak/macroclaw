import { z } from "zod/v4";
import {
  Claude,
  type ClaudeProcess,
  QueryParseError,
  QueryProcessError,
  type QueryResult,
  QueryValidationError,
} from "./claude";
import { writeHistoryPrompt, writeHistoryResult } from "./history";
import { createLogger } from "./logger";
import { generateName } from "./naming";
import {
  backgroundAgentProgressEvent,
  backgroundAgentResultEvent,
  backgroundAgentStartEvent,
  buttonClickEvent,
  healthCheckEvent,
  peekEvent,
  SYSTEM_PROMPT,
  scheduleTriggerEvent,
  userMessageEvent,
} from "./prompts";
import { Queue } from "./queue";
import { loadSessions, saveSessions } from "./sessions";

type ButtonSpec = string | { text: string; data: string };

const log = createLogger("orchestrator");

// --- Constants ---

const WAIT_THRESHOLD = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const HEALTH_CHECK_TIMEOUT_MS = 120 * 1000;

// --- Response schema ---

const backgroundAgentSchema = z.object({
  name: z.string().describe("Label for the background agent"),
  prompt: z.string().describe("The prompt/task for the background agent"),
  model: z.enum(["haiku", "sonnet", "opus"]).describe("Model to use for the background agent").optional(),
});

const agentOutputSchema = z.object({
  action: z.enum(["send", "silent"]).describe("'send' to reply to the user, 'silent' to do nothing"),
  actionReason: z.string().describe("Why the agent chose this action (logged, not sent)"),
  message: z.string().describe("The message to send to Telegram (required when action is 'send')").optional(),
  files: z.array(z.string()).describe("Absolute paths to files to send to Telegram").optional(),
  buttons: z.array(z.string()).describe("Button labels to show below the message").optional(),
  backgroundAgents: z.array(backgroundAgentSchema).describe("Background agents to spawn alongside this response").optional(),
});

type AgentOutput = z.infer<typeof agentOutputSchema>;

const healthCheckSchema = z.object({
  finished: z.boolean().describe("True if the task is complete, false if still working"),
  output: agentOutputSchema.optional().describe("Full output when finished=true"),
  progress: z.string().optional().describe("One-sentence status when finished=false"),
});

const responseResultType = { type: "object" as const, schema: agentOutputSchema };
const healthCheckResultType = { type: "object" as const, schema: healthCheckSchema };

const textResultType = { type: "text" } as const;

// --- Public response type ---

export type { ButtonSpec };
export type { Claude };

export interface OrchestratorResponse {
  message: string;
  files?: string[];
  buttons?: ButtonSpec[];
}

// --- Internal request types ---

type OrchestratorRequest =
  | { type: "user"; message: string; files?: string[] }
  | { type: "background-agent-result"; name: string; response: AgentOutput }
  | { type: "background-agent-progress"; name: string; progress: string }
  | { type: "button"; label: string };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Session tracking ---

interface SessionInfo {
  name: string;
  prompt: string;
  model?: string;
  process: ClaudeProcess<AgentOutput>;
  pendingResult: Promise<QueryResult<AgentOutput>>;
  lastMessageAt: Date;
  healthCheckTimer?: Timer;
}

export interface OrchestratorConfig {
  model?: string;
  workspace: string;
  settingsDir?: string;
  onResponse: (response: OrchestratorResponse) => Promise<void>;
  claude?: Claude;
  /** How long to wait for a running main session before demoting it (ms). Default: 60000 */
  waitThreshold?: number;
  /** Interval between background agent health checks (ms). Default: 300000. Set to 0 to disable. */
  healthCheckInterval?: number;
  /** Timeout for health check fork responses (ms). Default: 120000 */
  healthCheckTimeout?: number;
}

export class Orchestrator {
  #config: Omit<OrchestratorConfig , 'claude'>;
  #claude: Claude;
  #waitThreshold: number;
  #healthCheckInterval: number;
  #healthCheckTimeout: number;

  #mainSessionId: string | undefined;
  #mainProcess: ClaudeProcess<AgentOutput> | null = null;
  #runningSessions = new Map<string, SessionInfo>();
  #queue: Queue<OrchestratorRequest>;

  constructor(config: OrchestratorConfig) {
    this.#config = config;
    this.#claude = config.claude ?? new Claude({ workspace: config.workspace, systemPrompt: SYSTEM_PROMPT });
    this.#waitThreshold = config.waitThreshold ?? WAIT_THRESHOLD;
    this.#healthCheckInterval = config.healthCheckInterval ?? HEALTH_CHECK_INTERVAL_MS;
    this.#healthCheckTimeout = config.healthCheckTimeout ?? HEALTH_CHECK_TIMEOUT_MS;
    this.#queue = new Queue<OrchestratorRequest>();
    this.#queue.setHandler((request) => this.#handleRequest(request));

    this.#mainSessionId = loadSessions(config.settingsDir).mainSessionId;
  }

  // --- Public handle methods ---

  handleMessage(message: string, files?: string[]): void {
    this.#queue.push({ type: "user", message, files });
  }

  handleButton(label: string): void {
    this.#queue.push({ type: "button", label });
  }

  handleCron(name: string, prompt: string, model?: string, missed?: { missedBy: string; scheduledAt: string }): void {
    const cronName = `cron-${name}`;
    const formatted = scheduleTriggerEvent(
      cronName,
      { name, missedBy: missed?.missedBy, scheduledAt: missed?.scheduledAt },
      prompt,
    );
    this.#spawnBackgroundRaw(cronName, prompt, formatted, model ?? this.#config.model);
  }

  handleBackgroundCommand(prompt: string): void {
    const name = generateName(prompt);
    this.#spawnBackground(name, prompt, this.#config.model);
    this.#callOnResponse({ message: `Background agent "${escapeHtml(name)}" started.` });
  }

  handleSessions(): void {
    const sessions = [...this.#runningSessions.entries()];
    if (sessions.length === 0) {
      this.#callOnResponse({ message: "No running sessions." });
      return;
    }
    const lines = sessions.map(([sid, s]) => {
      const elapsed = Math.round((Date.now() - s.process.startedAt.getTime()) / 1000);
      const isMain = sid === this.#mainSessionId;
      return isMain
        ? `▶ ${escapeHtml(s.name)} (${elapsed}s) [main]`
        : `- ${escapeHtml(s.name)} (${elapsed}s)`;
    });
    const buttons: ButtonSpec[] = sessions.map(([sid, s]) => {
      const elapsed = Math.round((Date.now() - s.process.startedAt.getTime()) / 1000);
      const text = `${s.name} (${elapsed}s)`.slice(0, 27);
      return { text, data: `detail:${sid}` };
    });
    buttons.push({ text: "Dismiss", data: "_dismiss" });
    this.#callOnResponse({ message: lines.join("\n"), buttons });
  }

  handleDetail(sessionId: string): void {
    const session = this.#runningSessions.get(sessionId);
    if (!session) {
      this.#callOnResponse({ message: "Session not found or already finished." });
      return;
    }

    const elapsed = Math.round((Date.now() - session.process.startedAt.getTime()) / 1000);
    const truncatedPrompt = session.prompt.length > 300 ? `${session.prompt.slice(0, 300)}…` : session.prompt;
    const isMain = sessionId === this.#mainSessionId;
    const lines = [
      `<b>${escapeHtml(session.name)}</b>${isMain ? " [main]" : ""}`,
      `Prompt: ${escapeHtml(truncatedPrompt)}`,
      `Model: ${session.model ?? "default"}`,
      `Elapsed: ${elapsed}s`,
      "Status: running",
    ];
    const buttons: ButtonSpec[] = [
      { text: "Peek", data: `peek:${sessionId}` },
      { text: "Kill", data: `kill:${sessionId}` },
      { text: "Dismiss", data: "_dismiss" },
    ];
    this.#callOnResponse({ message: lines.join("\n"), buttons });
  }

  async handlePeek(sessionId: string): Promise<void> {
    const session = this.#runningSessions.get(sessionId);
    if (!session) {
      this.#callOnResponse({ message: "Session not found or already finished." });
      return;
    }

    this.#callOnResponse({ message: `Peeking at <b>${escapeHtml(session.name)}</b>...` });

    try {
      const prompt = peekEvent(
        `peek-${session.name}`,
        session.name,
        `Only consider progress since the "${session.name}" event. Brief status update: done, in progress, remaining. 2-3 sentences max, plain text.`,
      );
      const peekProcess = this.#claude.forkSession(
        sessionId,
        textResultType,
        { model: "haiku" },
      );
      const { value } = await peekProcess.send(prompt);
      peekProcess.kill().catch(() => {});
      this.#callOnResponse({ message: `<b>[${escapeHtml(session.name)}]</b> ${value || "[No output]"}` });
    } catch (err) {
      this.#callOnResponse({ message: `Couldn't peek at ${escapeHtml(session.name)}: ${err}` });
    }
  }

  async handleKill(sessionId: string): Promise<void> {
    const session = this.#runningSessions.get(sessionId);
    if (!session) {
      this.#callOnResponse({ message: "Session not found or already finished." });
      return;
    }

    this.#clearSession(sessionId);

    try {
      await session.process.kill();
    } catch (err) {
      log.error({ err, name: session.name }, "Kill failed");
    }

    this.#callOnResponse({ message: `Killed <b>${escapeHtml(session.name)}</b>.` });
  }

  async handleRestart(): Promise<void> {
    const sid = this.#mainProcess?.sessionId;
    if (sid) {
      this.#clearSession(sid);
    }
    if (this.#mainProcess) {
      try {
        await this.#mainProcess.kill();
      } catch (err) {
        log.error({ err }, "Failed to kill main process during restart");
      }
      this.#mainProcess = null;
    }
    log.info({ sessionId: this.#mainSessionId }, "Main session restarted");
    this.#callOnResponse({ message: "Session restarted." });
  }

  // --- Main process lifecycle ---

  #ensureMainProcess(): ClaudeProcess<AgentOutput> {
    if (this.#mainProcess && this.#mainProcess.state !== "dead") {
      return this.#mainProcess;
    }

    const opts = { model: this.#config.model };
    this.#mainProcess = this.#mainSessionId
      ? this.#claude.resumeSession(this.#mainSessionId, responseResultType, opts)
      : this.#claude.newSession(responseResultType, opts);

    if (this.#mainProcess.sessionId !== this.#mainSessionId) {
      this.#mainSessionId = this.#mainProcess.sessionId;
      saveSessions({ mainSessionId: this.#mainSessionId }, this.#config.settingsDir);
    }

    log.info({ sessionId: this.#mainSessionId }, "Main process created");
    return this.#mainProcess;
  }

  // --- Internal queue handler ---

  async #handleRequest(request: OrchestratorRequest): Promise<void> {
    log.debug({ type: request.type }, "Incoming request");

    let movedToBackground: string | undefined;
    let backgroundedName: string | undefined;
    const currentMain = this.#mainProcess;

    if (currentMain?.state === "busy") {
      const mainInfo = this.#runningSessions.get(currentMain.sessionId);
      if (mainInfo) {
        const elapsed = Date.now() - mainInfo.lastMessageAt.getTime();
        if (elapsed >= this.#waitThreshold) {
          movedToBackground = mainInfo.prompt;
          backgroundedName = mainInfo.name;
        } else {
          const remaining = this.#waitThreshold - elapsed;
          const finished = await Promise.race([
            mainInfo.pendingResult.then(() => true as const, () => true as const),
            new Promise<false>((r) => setTimeout(() => r(false), remaining)),
          ]);

          if (!finished) {
            movedToBackground = mainInfo.prompt;
            backgroundedName = mainInfo.name;
          }
        }
      }
    }

    if (movedToBackground && currentMain) {
      log.info({ name: backgroundedName, sessionId: currentMain.sessionId }, "Moving main session to background");
      this.#mainProcess = this.#claude.forkSession(
        this.#mainSessionId ?? currentMain.sessionId,
        responseResultType,
        { model: this.#config.model },
      );
      this.#mainSessionId = this.#mainProcess.sessionId;
      saveSessions({ mainSessionId: this.#mainSessionId }, this.#config.settingsDir);
    }

    await writeHistoryPrompt(request);

    const label = Orchestrator.#requestLabel(request);
    const name = generateName(label);
    const formatted = this.#formatPrompt(request, name, backgroundedName);

    this.#sendToMain(name, label, formatted);
  }

  // --- Main session send ---

  #sendToMain(name: string, displayPrompt: string, formatted: string): void {
    const process = this.#ensureMainProcess();
    const sid = process.sessionId;

    const pendingResult = process.send(formatted);
    this.#runningSessions.set(sid, {
      name,
      prompt: displayPrompt,
      model: this.#config.model,
      process,
      pendingResult,
      lastMessageAt: new Date(),
    });

    log.debug({ name, sessionId: sid }, "Main query sent");

    pendingResult.then(
      async ({ value: response }) => {
        if (!this.#runningSessions.has(sid)) {
          log.error({ name, sessionId: sid }, "Completed session not in runningSessions — delivering anyway");
          await this.#deliverResponse(response);
          return;
        }
        this.#clearSession(sid);

        if (process === this.#mainProcess) {
          log.debug({ name, sessionId: sid }, "Main query finished, delivering directly");
          await this.#deliverResponse(response);
        } else {
          log.debug({ name, sessionId: sid }, "Non-main query finished, feeding to main session");
          process.kill().catch(() => {});
          this.#queue.push({ type: "background-agent-result", name, response });
        }
      },
      async (err) => {
        if (!this.#runningSessions.has(sid)) {
          log.error({ name, sessionId: sid, err }, "Failed session not in runningSessions — delivering error");
        } else {
          this.#clearSession(sid);
          log.error({ name, sessionId: sid, err }, "Main query failed");
        }
        await this.#deliverResponse(this.#errorResponse(err));
      },
    );
  }

  // --- Response delivery ---

  async #deliverResponse(response: AgentOutput): Promise<void> {
    await writeHistoryResult(response);
    if (response.action === "send") {
      this.#callOnResponse({
        message: response.message || "[No output]",
        files: response.files,
        buttons: response.buttons,
      });
    } else {
      log.debug("Silent response");
    }

    if (response.backgroundAgents?.length) {
      for (const agent of response.backgroundAgents) {
        const agentModel = agent.model ?? this.#config.model;
        this.#spawnBackground(agent.name, agent.prompt, agentModel);
        this.#callOnResponse({ message: `Background agent "${escapeHtml(agent.name)}" started.` });
      }
    }
  }

  #callOnResponse(response: OrchestratorResponse): void {
    this.#config.onResponse(response).catch((err) => {
      log.error({ err }, "onResponse callback failed");
    });
  }

  #formatPrompt(request: OrchestratorRequest, name: string, backgroundedEvent?: string): string {
    switch (request.type) {
      case "user":
        return userMessageEvent(name, request.message || "", { files: request.files, backgroundedEvent });
      case "background-agent-result":
        return backgroundAgentResultEvent(
          name,
          request.name,
          { text: request.response.message || "[No output]", files: request.response.files },
          "Forward this result to the user (action=\"send\"). Summarize or add context from the conversation as appropriate.",
          { backgroundedEvent },
        );
      case "background-agent-progress":
        return backgroundAgentProgressEvent(
          name,
          request.name,
          request.progress,
          "This is an interim progress update, not a final result. Do not report to the user unless it contains exceptionally important information.",
          { backgroundedEvent },
        );
      case "button":
        return buttonClickEvent(name, request.label, { backgroundedEvent });
    }
  }

  static #requestLabel(request: OrchestratorRequest): string {
    switch (request.type) {
      case "user":
        return request.message;
      case "background-agent-result":
        return `bg:${request.name}`;
      case "background-agent-progress":
        return `progress:${request.name}`;
      case "button":
        return `btn:${request.label}`;
    }
  }

  #errorResponse(err: unknown): AgentOutput {
    if (err instanceof QueryProcessError) {
      return { action: "send", message: `[Error] Claude exited with code ${err.exitCode}:\n${err.stderr}`, actionReason: "process-error" };
    }
    if (err instanceof QueryParseError) {
      return { action: "send", message: `[JSON Error] ${err.raw}`, actionReason: "json-parse-failed" };
    }
    if (err instanceof QueryValidationError) {
      const rawObj = err.raw as Record<string, unknown> | null;
      const msg = typeof rawObj?.message === "string" ? rawObj.message : JSON.stringify(err.raw);
      return { action: "send", message: msg, actionReason: "validation-failed" };
    }
    throw err;
  }

  // --- Background management ---

  #spawnBackground(name: string, prompt: string, model: string | undefined) {
    const formatted = backgroundAgentStartEvent(name, prompt);
    this.#spawnBackgroundRaw(name, prompt, formatted, model);
  }

  #spawnBackgroundRaw(name: string, prompt: string, formatted: string, model: string | undefined) {
    const process = this.#mainSessionId
      ? this.#claude.forkSession(this.#mainSessionId, responseResultType, { model })
      : this.#claude.newSession(responseResultType, { model });

    const sid = process.sessionId;
    const pendingResult = process.send(formatted);

    const info: SessionInfo = { name, prompt, model, process, pendingResult, lastMessageAt: new Date() };
    this.#runningSessions.set(sid, info);

    log.debug({ name, sessionId: sid }, "Background session registered");

    this.#scheduleHealthCheck(sid);

    pendingResult.then(
      ({ value: response }) => {
        if (!this.#runningSessions.has(sid)) return;
        this.#clearSession(sid);
        process.kill().catch(() => {});
        log.debug({ name, message: response.message }, "Background session finished");
        this.#queue.push({ type: "background-agent-result", name, response });
      },
      (err) => {
        if (!this.#runningSessions.has(sid)) return;
        this.#clearSession(sid);
        process.kill().catch(() => {});
        log.error({ name, err }, "Background session failed");
        this.#queue.push({ type: "background-agent-result", name, response: { action: "send", message: `[Error] ${err}`, actionReason: "bg-failed" } });
      },
    );
  }

  // --- Session cleanup ---

  #clearSession(sessionId: string) {
    const info = this.#runningSessions.get(sessionId);
    if (info?.healthCheckTimer) clearTimeout(info.healthCheckTimer);
    this.#runningSessions.delete(sessionId);
  }

  // --- Health checks ---

  #scheduleHealthCheck(sessionId: string) {
    if (this.#healthCheckInterval <= 0) return;

    const info = this.#runningSessions.get(sessionId);
    if (!info) return;

    info.healthCheckTimer = setTimeout(() => {
      this.#runHealthCheck(sessionId);
    }, this.#healthCheckInterval);
  }

  async #runHealthCheck(sessionId: string): Promise<void> {
    const info = this.#runningSessions.get(sessionId);
    if (!info) return;

    log.debug({ name: info.name, sessionId }, "Running health check");

    const prompt = healthCheckEvent(
      `health-check-${info.name}`,
      info.name,
      "Report your current status. If your task is complete, set finished=true and provide the full output. If still working, set finished=false and describe current progress in one sentence.",
    );

    let hcProcess: ClaudeProcess<z.infer<typeof healthCheckSchema>>;
    try {
      hcProcess = this.#claude.forkSession(sessionId, healthCheckResultType, { model: "haiku" });
    } catch (err) {
      log.error({ name: info.name, sessionId, err }, "Health check fork failed");
      this.#scheduleHealthCheck(sessionId);
      return;
    }

    const result = await Promise.race([
      hcProcess.send(prompt).then((r) => r.value),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), this.#healthCheckTimeout)),
    ]);

    // Always kill health check process
    hcProcess.kill().catch(() => {});

    // Session may have completed/been killed while health check was running
    if (!this.#runningSessions.has(sessionId)) return;

    if (result === "timeout") {
      log.warn({ name: info.name, sessionId }, "Health check timed out, killing session");
      this.#clearSession(sessionId);
      try { await info.process.kill(); } catch { /* ignore */ }
      this.#callOnResponse({ message: `Agent <b>${escapeHtml(info.name)}</b> appears unresponsive, killed it.` });
      return;
    }

    if (result.finished) {
      log.info({ name: info.name, sessionId }, "Health check: agent reports finished");
      this.#clearSession(sessionId);
      try { await info.process.kill(); } catch { /* ignore */ }
      const response = result.output ?? { action: "send" as const, message: "[Agent finished but returned no output]", actionReason: "health-check-finished" };
      this.#queue.push({ type: "background-agent-result", name: info.name, response });
      return;
    }

    log.debug({ name: info.name, progress: result.progress }, "Health check: still running");
    if (result.progress) {
      this.#queue.push({
        type: "background-agent-progress",
        name: info.name,
        progress: result.progress,
      });
    }

    this.#scheduleHealthCheck(sessionId);
  }
}
