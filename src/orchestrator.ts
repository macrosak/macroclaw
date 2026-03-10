import { z } from "zod/v4";
import { type ClaudeOptions, ClaudeParseError, ClaudeProcessError, type ClaudeResult, ClaudeTimeoutError, runClaude } from "./claude";
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
  | { type: "background"; name: string; result: string }
  | { type: "timeout"; originalMessage: string }
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
  runClaude?: (options: ClaudeOptions) => Promise<ClaudeResult>;
}

export function createOrchestrator(config: OrchestratorConfig) {
  const claude = config.runClaude ?? runClaude;

  // Session state
  const settings = loadSettings(config.settingsDir);
  let sessionId: string;
  let sessionFlag: "--resume" | "--session-id";
  let sessionResolved = false;

  if (settings.sessionId) {
    sessionId = settings.sessionId;
    sessionFlag = "--resume";
  } else {
    sessionId = newSessionId();
    sessionFlag = "--session-id";
    saveSettings({ sessionId }, config.settingsDir);
    log.info({ sessionId }, "Created new session");
  }

  function buildRequest(request: OrchestratorRequest): {
    prompt: string;
    model: string | undefined;
    systemPrompt: string;
    timeout: number;
    files?: string[];
    useMainSession: boolean;
  } {
    switch (request.type) {
      case "user":
        return {
          prompt: buildPromptWithFiles(request.message, request.files),
          model: config.model,
          systemPrompt: PROMPT_USER_MESSAGE,
          timeout: MAIN_TIMEOUT,
          useMainSession: true,
        };
      case "cron":
        return {
          prompt: `[Tool: cron/${request.name}] ${request.prompt}`,
          model: request.model ?? config.model,
          systemPrompt: PROMPT_CRON_EVENT,
          timeout: CRON_TIMEOUT,
          useMainSession: true,
        };
      case "background":
        return {
          prompt: `[Background: ${request.name}] ${request.result}`,
          model: config.model,
          systemPrompt: PROMPT_BACKGROUND_RESULT,
          timeout: MAIN_TIMEOUT,
          useMainSession: true,
        };
      case "timeout":
        return {
          prompt: `[Timeout] The previous request timed out after ${MAIN_TIMEOUT / 1000} seconds. The user asked: "${request.originalMessage}". This task needs more time — spawn a background agent to handle it.`,
          model: config.model,
          systemPrompt: PROMPT_USER_MESSAGE,
          timeout: MAIN_TIMEOUT,
          useMainSession: true,
        };
      case "button":
        return {
          prompt: `The user clicked MessageButton: "${request.label}"`,
          model: config.model,
          systemPrompt: PROMPT_BUTTON_CLICK,
          timeout: MAIN_TIMEOUT,
          useMainSession: true,
        };
      case "bg-task":
        return {
          prompt: request.prompt,
          model: request.model ?? config.model,
          systemPrompt: promptBackgroundAgent(request.name),
          timeout: BG_TIMEOUT,
          useMainSession: false,
        };
    }
  }

  function buildPromptWithFiles(message: string, files?: string[]): string {
    if (!files?.length) return message;
    const prefix = files.map((f) => `[File: ${f}]`).join("\n");
    return message ? `${prefix}\n${message}` : prefix;
  }

  function validateResponse(raw: unknown): ClaudeResponse {
    const parsed = claudeResponseSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    log.warn({ error: parsed.error.message }, "structured_output failed validation");
    const rawObj = raw as Record<string, unknown> | null;
    const msg = typeof rawObj?.message === "string" ? rawObj.message : JSON.stringify(raw);
    return { action: "send", message: msg, actionReason: "validation-failed" };
  }

  async function callClaude(built: ReturnType<typeof buildRequest>, flag: "--resume" | "--session-id", sid: string): Promise<ClaudeResponse> {
    try {
      const result = await claude({
        prompt: built.prompt,
        sessionFlag: flag,
        sessionId: sid,
        model: built.model,
        workspace: config.workspace,
        systemPrompt: built.systemPrompt,
        jsonSchema,
        timeoutMs: built.timeout,
      });

      if (result.structuredOutput) {
        return validateResponse(result.structuredOutput);
      }

      log.error({ hasResult: !!result.result }, "No structured_output in response");
      const raw = result.result ? escapeHtml(result.result) : "";
      const msg = raw ? `[No structured output] ${raw}` : "[No output]";
      return { action: "send", message: msg, actionReason: "no-structured-output" };
    } catch (err) {
      if (err instanceof ClaudeTimeoutError) {
        return { action: "send", message: `[Error] Claude process timed out after ${Math.round(err.timeoutMs / 1000)}s.`, actionReason: "timeout" };
      }
      if (err instanceof ClaudeProcessError) {
        return { action: "send", message: `[Error] Claude exited with code ${err.exitCode}:\n${err.stderr}`, actionReason: "process-error" };
      }
      if (err instanceof ClaudeParseError) {
        return { action: "send", message: `[JSON Error] ${err.raw}`, actionReason: "json-parse-failed" };
      }
      throw err;
    }
  }

  return {
    get sessionId() {
      return sessionId;
    },

    async processRequest(request: OrchestratorRequest): Promise<ClaudeResponse> {
      const built = buildRequest(request);
      await logPrompt(request);

      if (built.useMainSession) {
        let response = await callClaude(built, sessionFlag, sessionId);

        // Session resolution: if resume failed on first call, create new session
        if (!sessionResolved && sessionFlag === "--resume" && response.actionReason === "process-error") {
          sessionId = newSessionId();
          log.info({ sessionId }, "Resume failed, created new session");
          sessionFlag = "--session-id";
          saveSettings({ sessionId }, config.settingsDir);
          response = await callClaude(built, sessionFlag, sessionId);
        }

        // Mark resolved on first success
        if (!sessionResolved && response.actionReason !== "process-error" && response.actionReason !== "timeout") {
          sessionResolved = true;
          sessionFlag = "--resume";
        }

        await logResult(response);
        return response;
      }

      // bg-task: fresh session, no session resolution
      const bgSessionId = newSessionId();
      log.debug({ name: (request as { name: string }).name, sessionId: bgSessionId }, "Processing bg-task");
      const bgResponse = await callClaude(built, "--session-id", bgSessionId);
      await logResult(bgResponse);
      return bgResponse;
    },
  };
}
