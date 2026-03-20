import { z } from "zod/v4";
import {
  Claude,
  QueryParseError,
  QueryProcessError,
  QueryValidationError,
  type RunningQuery
} from "./claude";
import { writeHistoryPrompt, writeHistoryResult } from "./history";
import { createLogger } from "./logger";
import { buildContextPrefix, type ContextInput, SYSTEM_PROMPT } from "./prompts";
import { Queue } from "./queue";
import { loadSessions, saveSessions } from "./sessions";

type ButtonSpec = string | { text: string; data: string };

const log = createLogger("orchestrator");

// --- Constants ---

const WAIT_THRESHOLD = 60_000;

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

const responseResultType = { type: "object" as const, schema: agentOutputSchema };

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
  | { type: "button"; label: string };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Session tracking ---

interface SessionInfo {
  name: string;
  prompt: string;
  model?: string;
  query: RunningQuery<AgentOutput>;
  lastMessageAt: Date;
}

export interface OrchestratorConfig {
  model?: string;
  workspace: string;
  settingsDir?: string;
  onResponse: (response: OrchestratorResponse) => Promise<void>;
  claude?: Claude;
  /** How long to wait for a running main session before demoting it (ms). Default: 60000 */
  waitThreshold?: number;
}

export class Orchestrator {
  #config: Omit<OrchestratorConfig , 'claude'>;
  #claude: Claude;
  #waitThreshold: number;

  #mainSessionId: string | undefined;
  #runningSessions = new Map<string, SessionInfo>();
  #queue: Queue<OrchestratorRequest>;

  constructor(config: OrchestratorConfig) {
    this.#config = config;
    this.#claude = config.claude ?? new Claude({ workspace: config.workspace, systemPrompt: SYSTEM_PROMPT });
    this.#waitThreshold = config.waitThreshold ?? WAIT_THRESHOLD;
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
    const cronContext = buildContextPrefix({
      session: "background",
      source: { type: "cron", name, missedBy: missed?.missedBy, scheduledAt: missed?.scheduledAt },
      content: { tag: "task", text: prompt },
    });
    this.#spawnBackgroundRaw(cronName, prompt, cronContext, model ?? this.#config.model);
  }

  handleBackgroundCommand(prompt: string): void {
    const name = prompt.slice(0, 30).replace(/\s+/g, "-");
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
      const elapsed = Math.round((Date.now() - s.query.startedAt.getTime()) / 1000);
      const isMain = sid === this.#mainSessionId;
      return isMain
        ? `▶ ${escapeHtml(s.name)} (${elapsed}s) [main]`
        : `- ${escapeHtml(s.name)} (${elapsed}s)`;
    });
    const buttons: ButtonSpec[] = sessions.map(([sid, s]) => {
      const elapsed = Math.round((Date.now() - s.query.startedAt.getTime()) / 1000);
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

    const elapsed = Math.round((Date.now() - session.query.startedAt.getTime()) / 1000);
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
      const startedAt = session.query.startedAt.toISOString();
      const query = this.#claude.forkSession(
        sessionId,
        `This session started at ${startedAt}. Only consider events after that time. Give a brief status update: what has been done so far, what's currently happening, and what's remaining. 2-3 sentences max.`,
        textResultType,
        { model: "haiku" },
      );
      const { value } = await query.result;
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

    this.#runningSessions.delete(sessionId);

    try {
      await session.query.kill();
    } catch (err) {
      log.error({ err, name: session.name }, "Kill failed");
    }

    this.#callOnResponse({ message: `Killed <b>${escapeHtml(session.name)}</b>.` });
  }


  // --- Internal queue handler ---

  async #handleRequest(request: OrchestratorRequest): Promise<void> {
    log.debug({ type: request.type }, "Incoming request");

    const mainInfo = this.#mainSessionId ? this.#runningSessions.get(this.#mainSessionId) : undefined;
    let movedToBackground: string | undefined;

    if (mainInfo) {
      const elapsed = Date.now() - mainInfo.lastMessageAt.getTime();
      if (elapsed >= this.#waitThreshold) {
        // Main has been running too long — move to background immediately
        log.info({ name: mainInfo.name, sessionId: mainInfo.query.sessionId }, "Moving main session to background (exceeded threshold)");
        movedToBackground = mainInfo.prompt;
      } else {
        // Main started recently — wait for it to finish or threshold
        const remaining = this.#waitThreshold - elapsed;
        const finished = await Promise.race([
          mainInfo.query.result.then(() => true as const, () => true as const),
          new Promise<false>((r) => setTimeout(() => r(false), remaining)),
        ]);

        if (!finished) {
          log.info({ name: mainInfo.name, sessionId: mainInfo.query.sessionId }, "Moving main session to background (wait timed out)");
          movedToBackground = mainInfo.prompt;
        }
        // If finished: completion handler already delivered the result and removed from map.
      }
    }

    await writeHistoryPrompt(request);

    let prompt = this.#formatPrompt(request);
    if (movedToBackground) {
      const truncated = movedToBackground.length > 100 ? `${movedToBackground.slice(0, 100)}...` : movedToBackground;
      const demotedContext = buildContextPrefix({
        session: "main",
        source: { type: "demoted-task", prompt: truncated },
      });
      prompt = `${demotedContext}\n${prompt}`;
    }

    this.#startMainQuery(prompt, this.#config.model);
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

  // --- Main session query ---

  #startMainQuery(prompt: string, model: string | undefined): void {
    const opts = { model };
    let query: RunningQuery<AgentOutput>;

    if (this.#mainSessionId && this.#runningSessions.has(this.#mainSessionId)) {
      query = this.#claude.forkSession(this.#mainSessionId, prompt, responseResultType, opts);
    } else if (this.#mainSessionId) {
      query = this.#claude.resumeSession(this.#mainSessionId, prompt, responseResultType, opts);
    } else {
      query = this.#claude.newSession(prompt, responseResultType, opts);
    }

    const sid = query.sessionId;
    const name = prompt.slice(0, 30).replace(/\s+/g, "-");
    this.#runningSessions.set(sid, { name, prompt, model, query, lastMessageAt: new Date() });

    if (sid !== this.#mainSessionId) {
      log.info({ oldSessionId: this.#mainSessionId, newSessionId: sid }, "Session updated");
      this.#mainSessionId = sid;
      saveSessions({ mainSessionId: sid }, this.#config.settingsDir);
    }

    log.debug({ name, sessionId: sid }, "Main query started");

    query.result.then(
      async ({ value: response }) => {
        if (!this.#runningSessions.has(sid)) {
          log.error({ name, sessionId: sid }, "Completed session not in runningSessions — delivering anyway");
          await this.#deliverResponse(response);
          return;
        }
        this.#runningSessions.delete(sid);

        if (sid === this.#mainSessionId) {
          log.debug({ name, sessionId: sid }, "Main query finished, delivering directly");
          await this.#deliverResponse(response);
        } else {
          log.debug({ name, sessionId: sid }, "Non-main query finished, feeding to main session");
          this.#queue.push({ type: "background-agent-result", name, response });
        }
      },
      async (err) => {
        if (!this.#runningSessions.has(sid)) {
          log.error({ name, sessionId: sid, err }, "Failed session not in runningSessions — delivering error");
        } else {
          this.#runningSessions.delete(sid);
          log.error({ name, sessionId: sid, err }, "Main query failed");
        }
        await this.#deliverResponse(this.#errorResponse(err));
      },
    );
  }

  #formatPrompt(request: OrchestratorRequest): string {
    let input: ContextInput;

    switch (request.type) {
      case "user":
        input = {
          session: "main",
          source: { type: "user" },
          content: request.message ? { tag: "prompt", text: request.message } : undefined,
          files: request.files,
        };
        break;
      case "background-agent-result":
        input = {
          session: "main",
          source: { type: "background-result", name: request.name },
          content: { tag: "result", text: request.response.message || "[No output]" },
        };
        break;
      case "button":
        input = {
          session: "main",
          source: { type: "button", label: request.label },
        };
        break;
    }

    return buildContextPrefix(input);
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
    const formatted = buildContextPrefix({
      session: "background",
      source: { type: "background-agent", name },
      content: { tag: "task", text: prompt },
    });
    this.#spawnBackgroundRaw(name, prompt, formatted, model);
  }

  #spawnBackgroundRaw(name: string, prompt: string, formatted: string, model: string | undefined) {
    const query = this.#mainSessionId
      ? this.#claude.forkSession(this.#mainSessionId, formatted, responseResultType, { model })
      : this.#claude.newSession(formatted, responseResultType, { model });
    this.#registerBackground(name, prompt, model, query);
  }

  #registerBackground(name: string, prompt: string, model: string | undefined, query: RunningQuery<AgentOutput>) {
    const sid = query.sessionId;
    this.#runningSessions.set(sid, { name, prompt, model, query, lastMessageAt: new Date() });

    log.debug({ name, sessionId: sid }, "Background session registered");

    query.result.then(
      ({ value: response }) => {
        if (!this.#runningSessions.has(sid)) return;
        this.#runningSessions.delete(sid);
        log.debug({ name, message: response.message }, "Background session finished");
        this.#queue.push({ type: "background-agent-result", name, response });
      },
      (err) => {
        if (!this.#runningSessions.has(sid)) return;
        this.#runningSessions.delete(sid);
        log.error({ name, err }, "Background session failed");
        this.#queue.push({ type: "background-agent-result", name, response: { action: "send", message: `[Error] ${err}`, actionReason: "bg-failed" } });
      },
    );
  }
}
