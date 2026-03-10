import { type ClaudeDeferredResult, isDeferred } from "./claude";
import { createLogger } from "./logger";
import type { ClaudeResponse, OrchestratorRequest } from "./orchestrator";
import { newSessionId } from "./settings";

const log = createLogger("background");

interface BackgroundInfo {
  name: string;
  sessionId: string;
  startTime: Date;
}

interface Queue {
  push(item: { type: "background"; name: string; result: string }): void;
}

interface Orchestrator {
  processRequest(request: OrchestratorRequest): Promise<ClaudeResponse | ClaudeDeferredResult>;
}

export function createBackgroundManager(orchestrator: Orchestrator) {
  const active = new Map<string, BackgroundInfo>();

  return {
    spawn(
      name: string,
      prompt: string,
      model: string | undefined,
      _workspace: string,
      queue: Queue,
    ) {
      const sessionId = newSessionId();
      const info: BackgroundInfo = { name, sessionId, startTime: new Date() };
      active.set(sessionId, info);

      log.debug({ name, sessionId }, "Starting background agent");

      orchestrator.processRequest({ type: "bg-task", name, prompt, model }).then(
        async (rawResponse) => {
          let response: ClaudeResponse;
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
          active.delete(sessionId);
          const result = (response.action === "send" ? response.message : "") || "[No output]";
          log.debug({ name, result }, "Background agent finished");
          queue.push({ type: "background", name, result });
        },
        (err) => {
          active.delete(sessionId);
          log.error({ name, err }, "Background agent failed");
          queue.push({ type: "background", name, result: `[Error] ${err}` });
        },
      );
    },

    list(): { name: string; sessionId: string; startTime: Date }[] {
      return [...active.values()];
    },

    get size() {
      return active.size;
    },
  };
}
