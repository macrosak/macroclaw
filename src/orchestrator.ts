import { type ClaudeResponse, runClaude } from "./claude";
import { createLogger } from "./logger";
import { BG_TIMEOUT, CRON_TIMEOUT, MAIN_TIMEOUT, PROMPT_BACKGROUND_RESULT, PROMPT_CRON_EVENT, PROMPT_USER_MESSAGE, promptBackgroundAgent } from "./prompts";
import { loadSettings, newSessionId, saveSettings } from "./settings";

const log = createLogger("orchestrator");

export type OrchestratorRequest =
  | { type: "user"; message: string; files?: string[] }
  | { type: "cron"; name: string; prompt: string; model?: string }
  | { type: "background"; name: string; result: string }
  | { type: "timeout"; originalMessage: string }
  | { type: "bg-task"; name: string; prompt: string; model?: string };

export interface OrchestratorConfig {
  model?: string;
  workspace: string;
  settingsDir?: string;
  runClaude?: typeof runClaude;
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
          prompt: request.message,
          model: config.model,
          systemPrompt: PROMPT_USER_MESSAGE,
          timeout: MAIN_TIMEOUT,
          files: request.files,
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

  return {
    get sessionId() {
      return sessionId;
    },

    async processRequest(request: OrchestratorRequest): Promise<ClaudeResponse> {
      const built = buildRequest(request);

      if (built.useMainSession) {
        let response = await claude(built.prompt, sessionFlag, sessionId, built.model, config.workspace, built.systemPrompt, built.timeout, built.files);

        // Session resolution: if resume failed on first call, create new session
        if (!sessionResolved && sessionFlag === "--resume" && response.actionReason === "process-error") {
          sessionId = newSessionId();
          log.info({ sessionId }, "Resume failed, created new session");
          sessionFlag = "--session-id";
          saveSettings({ sessionId }, config.settingsDir);
          response = await claude(built.prompt, sessionFlag, sessionId, built.model, config.workspace, built.systemPrompt, built.timeout, built.files);
        }

        // Mark resolved on first success
        if (!sessionResolved && response.actionReason !== "process-error" && response.actionReason !== "timeout") {
          sessionResolved = true;
          sessionFlag = "--resume";
        }

        return response;
      }

      // bg-task: fresh session, no session resolution
      const bgSessionId = newSessionId();
      log.debug({ name: (request as { name: string }).name, sessionId: bgSessionId }, "Processing bg-task");
      return claude(built.prompt, "--session-id", bgSessionId, built.model, config.workspace, built.systemPrompt, built.timeout);
    },
  };
}
