import { z } from "zod/v4";
import { Claude, type ClaudeDeferredResult, ClaudeParseError, ClaudeProcessError, type ClaudeResult, isDeferred } from "./claude";
import { logPrompt, logResult } from "./history";
import { createLogger } from "./logger";
import { BG_TIMEOUT, CRON_TIMEOUT, MAIN_TIMEOUT, PROMPT_BACKGROUND_RESULT, PROMPT_BUTTON_CLICK, PROMPT_CRON_EVENT, PROMPT_USER_MESSAGE, promptBackgroundAgent } from "./prompts";
import { loadSettings, newSessionId, saveSettings } from "./settings";

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

export type ClaudeResponse = z.infer<typeof claudeResponseSchema>;

const jsonSchema = JSON.stringify(z.toJSONSchema(claudeResponseSchema, { target: "jsonSchema7" }));

// --- Request types ---

export type OrchestratorRequest =
  | { type: "user"; message: string; files?: string[] }
  | { type: "cron"; name: string; prompt: string; model?: string }
  | { type: "background"; name: string; result: string; sessionId?: string }
  | { type: "bg-task"; name: string; prompt: string; model?: string }
  | { type: "button"; label: string };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Orchestrator ---

export interface OrchestratorConfig {
  model?: string;
  workspace: string;
  settingsDir?: string;
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
  response: ClaudeResponse;
  sessionId: string;
}

export class Orchestrator {
  #claude: Claude;
  #settings: ReturnType<typeof loadSettings>;
  #sessionId: string;
  #sessionFlag: "--resume" | "--session-id";
  #sessionResolved = false;
  #config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.#config = config;
    this.#claude = config.claude ?? new Claude({ workspace: config.workspace, jsonSchema });
    this.#settings = loadSettings(config.settingsDir);

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

  get sessionId() {
    return this.#sessionId;
  }

  async processRequest(request: OrchestratorRequest, options?: { forkSession?: boolean }): Promise<ClaudeResponse | ClaudeDeferredResult> {
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

    // bg-task: fork from main session for full context
    log.debug({ name: (request as { name: string }).name }, "Processing bg-task (forked session)");
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
      case "background":
        return {
          prompt: `[Background: ${request.name}] ${request.result}`,
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
      case "bg-task":
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

  #validateResponse(raw: unknown): ClaudeResponse {
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
