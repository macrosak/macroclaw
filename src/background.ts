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

export interface BackgroundQueueItem {
  type: "background";
  name: string;
  result: string;
  sessionId?: string;
}

interface Queue {
  push(item: BackgroundQueueItem): void;
}

interface Orchestrator {
  processRequest(request: OrchestratorRequest, options?: { forkSession?: boolean }): Promise<ClaudeResponse | ClaudeDeferredResult>;
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

    adopt(
      name: string,
      sessionId: string,
      completion: Promise<ClaudeResponse>,
      queue: Queue,
    ) {
      const info: BackgroundInfo = { name, sessionId, startTime: new Date() };
      active.set(sessionId, info);

      log.debug({ name, sessionId }, "Adopting backgrounded task");

      completion.then(
        (response) => {
          active.delete(sessionId);
          const result = (response.action === "send" ? response.message : "") || "[No output]";
          log.debug({ name, result }, "Adopted task finished");
          queue.push({ type: "background", name, result, sessionId });
        },
        (err) => {
          active.delete(sessionId);
          log.error({ name, err }, "Adopted task failed");
          queue.push({ type: "background", name, result: `[Error] ${err}`, sessionId });
        },
      );
    },

    hasSessionId(sessionId: string): boolean {
      return active.has(sessionId);
    },

    list(): { name: string; sessionId: string; startTime: Date }[] {
      return [...active.values()];
    },

    get size() {
      return active.size;
    },
  };
}
