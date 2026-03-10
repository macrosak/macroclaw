import { z } from "zod/v4";
import { Claude, type ClaudeDeferredResult, ClaudeParseError, ClaudeProcessError, type ClaudeResult, isDeferred } from "./claude";
import { logPrompt, logResult } from "./history";
import { createLogger } from "./logger";
import { BG_TIMEOUT, CRON_TIMEOUT, MAIN_TIMEOUT, PROMPT_BACKGROUND_RESULT, PROMPT_BUTTON_CLICK, PROMPT_CRON_EVENT, PROMPT_USER_MESSAGE, promptBackgroundAgent } from "./prompts";
import { Queue } from "./queue";
import { loadSettings, newSessionId, type Settings, saveSettings } from "./settings";

const log = createLogger("orchestrator");

// --- Response schema (owned by orchestrator) ---
// Flat object (no oneOf/discriminatedUnion) — Claude CLI --json-schema requires a single top-level object.

const backgroundAgentSchema = z.object({
  name: z.string().describe("Label for the background agent"),
  prompt: z.string().describe("The prompt/task for the background agent"),
  model: z.enum(["haiku", "sonnet", "opus"]).describe("Model to use for the background agent").optional(),
});

const buttonSchema = z.object({
  label: z.string().describe("Button text shown to the user"),
});

const claudeResponseSchema = z.object({
  action: z.enum(["send", "silent"]).describe("'send' to reply to the user, 'silent' to do nothing"),
  actionReason: z.string().describe("Why the agent chose this action (logged, not sent)"),
  message: z.string().describe("The message to send to Telegram (required when action is 'send')").optional(),
  files: z.array(z.string()).describe("Absolute paths to files to send to Telegram").optional(),
  buttons: z.array(z.array(buttonSchema)).describe("Inline keyboard rows; each row is an array of buttons").optional(),
  backgroundAgents: z.array(backgroundAgentSchema).describe("Background agents to spawn alongside this response").optional(),
});

type ClaudeResponseInternal = z.infer<typeof claudeResponseSchema>;

const jsonSchema = JSON.stringify(z.toJSONSchema(claudeResponseSchema, { target: "jsonSchema7" }));

// --- Public response type ---

export interface OrchestratorResponse {
  message: string;
  files?: string[];
  buttons?: Array<Array<{ label: string }>>;
}

// --- Internal request types ---

type OrchestratorRequest =
  | { type: "user"; message: string; files?: string[] }
  | { type: "cron"; name: string; prompt: string; model?: string }
  | { type: "background-agent-result"; name: string; response: ClaudeResponseInternal; sessionId?: string }
  | { type: "background-agent"; name: string; prompt: string; model?: string }
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

// --- Orchestrator ---

export interface OrchestratorConfig {
  model?: string;
  workspace: string;
  settingsDir?: string;
  onResponse: (response: OrchestratorResponse) => Promise<void>;
  claude?: Claude;
}

interface BuiltRequest {
  prompt: string;
  model: string | undefined;
  systemPrompt: string;
  timeout: number;
  files?: string[];
  useMainSession: boolean;
}

interface CallResult {
  response: ClaudeResponseInternal;
  sessionId: string;
}

export class Orchestrator {
  #claude: Claude;
  #settings: Settings;
  #sessionId: string;
  #sessionFlag: "--resume" | "--session-id";
  #sessionResolved = false;
  #config: OrchestratorConfig;
  #active = new Map<string, BackgroundInfo>();
  #queue: Queue<OrchestratorRequest>;

  constructor(config: OrchestratorConfig) {
    this.#config = config;
    this.#claude = config.claude ?? new Claude({ workspace: config.workspace, jsonSchema });
    this.#settings = loadSettings(config.settingsDir);
    this.#queue = new Queue<OrchestratorRequest>();
    this.#queue.setHandler((request) => this.#handleRequest(request));

    if (this.#settings.sessionId) {
      this.#sessionId = this.#settings.sessionId;
      this.#sessionFlag = "--resume";
    } else {
      this.#sessionId = newSessionId();
      this.#sessionFlag = "--session-id";
      saveSettings({ sessionId: this.#sessionId }, config.settingsDir);
      log.info({ sessionId: this.#sessionId }, "Created new session");
    }
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
    const agents = [...this.#active.values()];
    if (agents.length === 0) {
      this.#callOnResponse({ message: "No background agents running." });
      return;
    }
    const lines = agents.map((a) => {
      const elapsed = Math.round((Date.now() - a.startTime.getTime()) / 1000);
      return `- ${escapeHtml(a.name)} (${elapsed}s)`;
    });
    this.#callOnResponse({ message: lines.join("\n") });
  }

  handleSessionCommand(): void {
    this.#callOnResponse({ message: `Session: <code>${this.#sessionId}</code>` });
  }

  // --- Internal queue handler ---

  async #handleRequest(request: OrchestratorRequest): Promise<void> {
    log.debug({ type: request.type }, "Incoming request");

    // Background result with matching session ID: deliver directly without Claude round-trip
    if (request.type === "background-agent-result" && "sessionId" in request && request.sessionId === this.#sessionId) {
      log.debug({ name: request.name }, "Background result on current session, applying directly");
      await this.#deliverClaudeResponse(request.response);
      return;
    }

    // Fork session if a backgrounded task is running on the main session
    const needsFork = (request.type === "user" || request.type === "button") && this.#active.has(this.#sessionId);

    const rawResponse = await this.#processRequest(request, needsFork ? { forkSession: true } : undefined);
    if (isDeferred(rawResponse)) {
      const name = request.type === "user" ? request.message.slice(0, 30).replace(/\s+/g, "-")
        : request.type === "cron" ? `cron-${request.name}`
        : "task";
      log.info({ name, sessionId: rawResponse.sessionId }, "Request backgrounded due to timeout");
      this.#callOnResponse({ message: "This is taking longer, continuing in the background." });
      this.#adoptBackground(name, rawResponse.sessionId, rawResponse.completion.then(
        (r) => {
          const msg = r.structuredOutput ? String((r.structuredOutput as Record<string, unknown>).message ?? "") : (r.result ?? "");
          return { action: "send" as const, message: msg, actionReason: "deferred-completed" };
        },
        (err) => ({ action: "send" as const, message: `[Error] ${err}`, actionReason: "deferred-failed" }),
      ));
      return;
    }

    log.debug({ action: rawResponse.action, actionReason: rawResponse.actionReason }, "Response");
    await this.#deliverClaudeResponse(rawResponse);
  }

  async #deliverClaudeResponse(response: ClaudeResponseInternal): Promise<void> {
    if (response.action === "send") {
      await this.#config.onResponse({
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

  // --- Internal background management ---

  #spawnBackground(name: string, prompt: string, model: string | undefined) {
    const sessionId = newSessionId();
    const info: BackgroundInfo = { name, sessionId, startTime: new Date() };
    this.#active.set(sessionId, info);

    log.debug({ name, sessionId }, "Starting background agent");

    this.#processRequest({ type: "background-agent", name, prompt, model }).then(
      async (rawResponse) => {
        let response: ClaudeResponseInternal;
        if (isDeferred(rawResponse)) {
          try {
            const r = await rawResponse.completion;
            response = { action: "send", message: String(r.structuredOutput ?? r.result ?? ""), actionReason: "deferred-completed" };
          } catch (err) {
            response = { action: "send", message: `[Error] ${err}`, actionReason: "deferred-failed" };
          }
        } else {
          response = rawResponse;
        }
        this.#active.delete(sessionId);
        log.debug({ name, message: response.message }, "Background agent finished");
        this.#queue.push({ type: "background-agent-result", name, response });
      },
      (err) => {
        this.#active.delete(sessionId);
        log.error({ name, err }, "Background agent failed");
        this.#queue.push({ type: "background-agent-result", name, response: { action: "send", message: `[Error] ${err}`, actionReason: "bg-agent-failed" } });
      },
    );
  }

  #adoptBackground(name: string, sessionId: string, completion: Promise<ClaudeResponseInternal>) {
    const info: BackgroundInfo = { name, sessionId, startTime: new Date() };
    this.#active.set(sessionId, info);

    log.debug({ name, sessionId }, "Adopting backgrounded task");

    completion.then(
      (response) => {
        this.#active.delete(sessionId);
        log.debug({ name, message: response.message }, "Adopted task finished");
        this.#queue.push({ type: "background-agent-result", name, response, sessionId });
      },
      (err) => {
        this.#active.delete(sessionId);
        log.error({ name, err }, "Adopted task failed");
        this.#queue.push({ type: "background-agent-result", name, response: { action: "send", message: `[Error] ${err}`, actionReason: "adopted-task-failed" }, sessionId });
      },
    );
  }

  // --- Core Claude processing ---

  async #processRequest(request: OrchestratorRequest, options?: { forkSession?: boolean }): Promise<ClaudeResponseInternal | ClaudeDeferredResult> {
    const built = this.#buildRequest(request);
    await logPrompt(request);

    if (built.useMainSession) {
      let result = await this.#callClaude(built, this.#sessionFlag, this.#sessionId, options?.forkSession);

      // Session resolution: if resume failed on first call, create new session
      if (!isDeferred(result) && !this.#sessionResolved && this.#sessionFlag === "--resume" && result.response.actionReason === "process-error") {
        this.#sessionId = newSessionId();
        log.info({ sessionId: this.#sessionId }, "Resume failed, created new session");
        this.#sessionFlag = "--session-id";
        saveSettings({ sessionId: this.#sessionId }, this.#config.settingsDir);
        result = await this.#callClaude(built, this.#sessionFlag, this.#sessionId);
      }

      if (isDeferred(result)) return result;

      // Update session ID from response (important after fork)
      if (result.sessionId && result.sessionId !== this.#sessionId) {
        log.info({ oldSessionId: this.#sessionId, newSessionId: result.sessionId }, "Session forked, updating session ID");
        this.#sessionId = result.sessionId;
        saveSettings({ sessionId: this.#sessionId }, this.#config.settingsDir);
      }

      // Mark resolved on first success
      if (!this.#sessionResolved && result.response.actionReason !== "process-error") {
        this.#sessionResolved = true;
        this.#sessionFlag = "--resume";
      }

      await logResult(result.response);
      return result.response;
    }

    // background-agent: fork from main session for full context
    log.debug({ name: (request as { name: string }).name }, "Processing background-agent (forked session)");
    const bgResult = await this.#callClaude(built, "--resume", this.#sessionId, true);
    if (isDeferred(bgResult)) return bgResult;
    await logResult(bgResult.response);
    return bgResult.response;
  }

  #buildRequest(request: OrchestratorRequest): BuiltRequest {
    switch (request.type) {
      case "user":
        return {
          prompt: this.#buildPromptWithFiles(request.message, request.files),
          model: this.#config.model,
          systemPrompt: PROMPT_USER_MESSAGE,
          timeout: MAIN_TIMEOUT,
          useMainSession: true,
        };
      case "cron":
        return {
          prompt: `[Tool: cron/${request.name}] ${request.prompt}`,
          model: request.model ?? this.#config.model,
          systemPrompt: PROMPT_CRON_EVENT,
          timeout: CRON_TIMEOUT,
          useMainSession: true,
        };
      case "background-agent-result":
        return {
          prompt: `[Background: ${request.name}] ${request.response.message || "[No output]"}`,
          model: this.#config.model,
          systemPrompt: PROMPT_BACKGROUND_RESULT,
          timeout: MAIN_TIMEOUT,
          useMainSession: true,
        };
      case "button":
        return {
          prompt: `The user clicked MessageButton: "${request.label}"`,
          model: this.#config.model,
          systemPrompt: PROMPT_BUTTON_CLICK,
          timeout: MAIN_TIMEOUT,
          useMainSession: true,
        };
      case "background-agent":
        return {
          prompt: request.prompt,
          model: request.model ?? this.#config.model,
          systemPrompt: promptBackgroundAgent(request.name),
          timeout: BG_TIMEOUT,
          useMainSession: false,
        };
    }
  }

  #buildPromptWithFiles(message: string, files?: string[]): string {
    if (!files?.length) return message;
    const prefix = files.map((f) => `[File: ${f}]`).join("\n");
    return message ? `${prefix}\n${message}` : prefix;
  }

  #validateResponse(raw: unknown): ClaudeResponseInternal {
    const parsed = claudeResponseSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    log.warn({ error: parsed.error.message }, "structured_output failed validation");
    const rawObj = raw as Record<string, unknown> | null;
    const msg = typeof rawObj?.message === "string" ? rawObj.message : JSON.stringify(raw);
    return { action: "send", message: msg, actionReason: "validation-failed" };
  }

  #resultToCallResult(result: ClaudeResult): CallResult {
    if (result.structuredOutput) {
      return { response: this.#validateResponse(result.structuredOutput), sessionId: result.sessionId };
    }
    log.error({ hasResult: !!result.result }, "No structured_output in response");
    const raw = result.result ? escapeHtml(result.result) : "";
    const msg = raw ? `[No structured output] ${raw}` : "[No output]";
    return { response: { action: "send", message: msg, actionReason: "no-structured-output" }, sessionId: result.sessionId };
  }

  async #callClaude(built: BuiltRequest, flag: "--resume" | "--session-id", sid: string, forkSession?: boolean): Promise<CallResult | ClaudeDeferredResult> {
    try {
      const result = await this.#claude.run({
        prompt: built.prompt,
        sessionFlag: flag,
        sessionId: sid,
        forkSession,
        model: built.model,
        systemPrompt: built.systemPrompt,
        timeoutMs: built.timeout,
      });

      if (isDeferred(result)) return result;

      return this.#resultToCallResult(result);
    } catch (err) {
      if (err instanceof ClaudeProcessError) {
        return { response: { action: "send", message: `[Error] Claude exited with code ${err.exitCode}:\n${err.stderr}`, actionReason: "process-error" }, sessionId: sid };
      }
      if (err instanceof ClaudeParseError) {
        return { response: { action: "send", message: `[JSON Error] ${err.raw}`, actionReason: "json-parse-failed" }, sessionId: sid };
      }
      throw err;
    }
  }
}
