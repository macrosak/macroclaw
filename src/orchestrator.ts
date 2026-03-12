import { z } from "zod/v4";
import {
  Claude,
  QueryParseError,
  QueryProcessError,
  type QueryResult,
  QueryValidationError,
  type RunningQuery
} from "./claude";
import { writeHistoryPrompt, writeHistoryResult } from "./history";
import { createLogger } from "./logger";
import { CRON_TIMEOUT, MAIN_TIMEOUT, SYSTEM_PROMPT } from "./prompts";
import { Queue } from "./queue";
import { loadSessions, saveSessions } from "./sessions";
import type { ButtonSpec } from "./telegram";

const log = createLogger("orchestrator");

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

export interface OrchestratorResponse {
  message: string;
  files?: string[];
  buttons?: ButtonSpec[];
}

// --- Internal request types ---

type OrchestratorRequest =
  | { type: "user"; message: string; files?: string[] }
  | { type: "cron"; name: string; prompt: string; model?: string }
  | { type: "background-agent-result"; name: string; response: AgentOutput; sessionId?: string }
  | { type: "button"; label: string };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Background tracking ---

interface BackgroundInfo {
  name: string;
  sessionId: string;
  startTime: Date;
}

export interface OrchestratorConfig {
  model?: string;
  workspace: string;
  settingsDir?: string;
  onResponse: (response: OrchestratorResponse) => Promise<void>;
  claude?: Claude;
}

export class Orchestrator {
  #config: Omit<OrchestratorConfig , 'claude'>;
  #claude: Claude;

  #mainSessionId: string | undefined;
  #backgroundAgents = new Map<string, BackgroundInfo>();
  #queue: Queue<OrchestratorRequest>;

  constructor(config: OrchestratorConfig) {
    this.#config = config;
    this.#claude = config.claude ?? new Claude({ workspace: config.workspace, systemPrompt: SYSTEM_PROMPT });
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

  handleCron(name: string, prompt: string, model?: string): void {
    this.#queue.push({ type: "cron", name, prompt, model });
  }

  handleBackgroundCommand(prompt: string): void {
    const name = prompt.slice(0, 30).replace(/\s+/g, "-");
    this.#spawnBackground(name, prompt, this.#config.model);
    this.#callOnResponse({ message: `Background agent "${escapeHtml(name)}" started.` });
  }

  handleBackgroundList(): void {
    const agents = [...this.#backgroundAgents.values()];
    if (agents.length === 0) {
      this.#callOnResponse({ message: "No background agents running." });
      return;
    }
    const lines = agents.map((a) => {
      const elapsed = Math.round((Date.now() - a.startTime.getTime()) / 1000);
      return `- ${escapeHtml(a.name)} (${elapsed}s)`;
    });
    const buttons: ButtonSpec[] = agents.map((a) => {
      const elapsed = Math.round((Date.now() - a.startTime.getTime()) / 1000);
      const text = `${a.name} (${elapsed}s)`.slice(0, 27);
      return { text, data: `peek:${a.sessionId}` };
    });
    buttons.push({text: "Dismiss", data: "_dismiss"});
    this.#callOnResponse({ message: lines.join("\n"), buttons });
  }

  async handlePeek(sessionId: string): Promise<void> {
    const agent = this.#backgroundAgents.get(sessionId);
    if (!agent) {
      this.#callOnResponse({ message: "Agent not found or already finished." });
      return;
    }

    this.#callOnResponse({ message: `Peeking at <b>${escapeHtml(agent.name)}</b>...` });

    try {
      const query = this.#claude.forkSession(
        sessionId,
        "Give a brief status update: what has been done so far, what's currently happening, and what's remaining. 2-3 sentences max.",
        textResultType,
        { model: "haiku" },
      );
      const { value } = await query.result;
      this.#callOnResponse({ message: `<b>[${escapeHtml(agent.name)}]</b> ${value || "[No output]"}` });
    } catch (err) {
      this.#callOnResponse({ message: `Couldn't peek at ${escapeHtml(agent.name)}: ${err}` });
    }
  }

  handleSessionCommand(): void {
    this.#callOnResponse({ message: `Session: <code>${this.#mainSessionId ?? "none"}</code>` });
  }

  // --- Internal queue handler ---

  async #handleRequest(request: OrchestratorRequest): Promise<void> {
    log.debug({ type: request.type }, "Incoming request");

    // Background result with matching session ID: deliver directly
    if (request.type === "background-agent-result" && request.sessionId === this.#mainSessionId) {
      log.debug({ name: request.name }, "Background result on current session, applying directly");
      await this.#deliverResponse(request.response);
      return;
    }

    await writeHistoryPrompt(request);

    const result = await this.#queryWithRetry(request);
    if (!result) return;

    // Update session ID (important after fork or new session)
    if (result.sessionId !== this.#mainSessionId) {
      log.info({ oldSessionId: this.#mainSessionId, newSessionId: result.sessionId }, "Session updated");
      this.#mainSessionId = result.sessionId;
      saveSessions({ mainSessionId: this.#mainSessionId }, this.#config.settingsDir);
    }

    await writeHistoryResult(result.value);
    await this.#deliverResponse(result.value);
  }

  // --- Response delivery ---

  async #deliverResponse(response: AgentOutput): Promise<void> {
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

  // --- Claude calls ---

  async #queryWithRetry(request: OrchestratorRequest): Promise<QueryResult<AgentOutput> | null> {
    const timeout = request.type === "cron" ? CRON_TIMEOUT : MAIN_TIMEOUT;
    const query = this.#query(request);

    try {
      const result = await this.#awaitOrBackground(query, request, timeout);
      if (!result) return null;
      return result;
    } catch (err) {
      // Resume failed — retry with a fresh session
      if (err instanceof QueryProcessError && this.#mainSessionId) {
        log.info("Resume failed, retrying with new session");
        this.#mainSessionId = undefined;
        const retryQuery = this.#query(request);

        try {
          const retryResult = await this.#awaitOrBackground(retryQuery, request, timeout);
          if (!retryResult) return null;
          return retryResult;
        } catch (retryErr) {
          return { value: this.#errorResponse(retryErr), sessionId: retryQuery.sessionId };
        }
      }

      return { value: this.#errorResponse(err), sessionId: this.#mainSessionId ?? "" };
    }
  }

  #query(request: OrchestratorRequest) {
    const prompt = this.#formatPrompt(request);
    const model = request.type === "cron" ? (request.model ?? this.#config.model) : this.#config.model;
    const opts = { model };

    // Fork if a background agent is running on the main session
    if (this.#mainSessionId && this.#backgroundAgents.has(this.#mainSessionId)) {
      return this.#claude.forkSession(this.#mainSessionId, prompt, responseResultType, opts);
    }

    // Resume existing session
    if (this.#mainSessionId) {
      return this.#claude.resumeSession(this.#mainSessionId, prompt, responseResultType, opts);
    }

    // Start fresh
    return this.#claude.newSession(prompt, responseResultType, opts);
  }

  #formatPrompt(request: OrchestratorRequest): string {
    switch (request.type) {
      case "user": {
        if (!request.files?.length) return request.message;
        const prefix = request.files.map((f) => `[File: ${f}]`).join("\n");
        return request.message ? `${prefix}\n${request.message}` : prefix;
      }
      case "cron":
        return `[Context: cron/${request.name}] ${request.prompt}`;
      case "background-agent-result":
        return `[Context: background-result/${request.name}] ${request.response.message || "[No output]"}`;
      case "button":
        return `[Context: button-click] User tapped "${request.label}"`;
    }
  }

  async #awaitOrBackground(
    query: RunningQuery<AgentOutput>,
    request: OrchestratorRequest,
    timeoutMs: number,
  ): Promise<QueryResult<AgentOutput> | null> {
    const result = await Promise.race([
      query.result,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (result !== null) return result;

    const name = request.type === "user" ? request.message.slice(0, 30).replace(/\s+/g, "-")
      : request.type === "cron" ? `cron-${request.name}`
      : "task";
    log.info({ name, sessionId: query.sessionId }, "Request backgrounded due to timeout");
    this.#callOnResponse({ message: "This is taking longer, continuing in the background." });
    this.#adoptBackground(name, query.sessionId, query.startedAt, query.result);
    return null;
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
    const bgPrompt = `[Context: background-agent/${name}] ${prompt}`;
    const query = this.#mainSessionId
      ? this.#claude.forkSession(this.#mainSessionId, bgPrompt, responseResultType, { model })
      : this.#claude.newSession(bgPrompt, responseResultType, { model });
    const sessionId = query.sessionId;
    const info: BackgroundInfo = { name, sessionId, startTime: query.startedAt };
    this.#backgroundAgents.set(sessionId, info);

    log.debug({ name, sessionId }, "Starting background agent");

    query.result.then(
      async ({ value: response }) => {
        this.#backgroundAgents.delete(sessionId);
        log.debug({ name, message: response.message }, "Background agent finished");
        this.#queue.push({ type: "background-agent-result", name, response });
      },
      (err) => {
        this.#backgroundAgents.delete(sessionId);
        log.error({ name, err }, "Background agent failed");
        this.#queue.push({ type: "background-agent-result", name, response: { action: "send", message: `[Error] ${err}`, actionReason: "bg-agent-failed" } });
      },
    );
  }

  #adoptBackground(name: string, sessionId: string, startTime: Date, completion: Promise<QueryResult<AgentOutput>>) {
    const info: BackgroundInfo = { name, sessionId, startTime };
    this.#backgroundAgents.set(sessionId, info);

    log.debug({ name, sessionId }, "Adopting backgrounded task");

    completion.then(
      ({ value: response }) => {
        this.#backgroundAgents.delete(sessionId);
        log.debug({ name }, "Adopted task finished");
        this.#queue.push({ type: "background-agent-result", name, response, sessionId });
      },
      (err) => {
        this.#backgroundAgents.delete(sessionId);
        log.error({ name, err }, "Adopted task failed");
        this.#queue.push({ type: "background-agent-result", name, response: { action: "send", message: `[Error] ${err}`, actionReason: "deferred-failed" }, sessionId });
      },
    );
  }
}
