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
  type: "background-agent-result";
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

export class BackgroundManager {
  #active = new Map<string, BackgroundInfo>();
  #orchestrator: Orchestrator;

  constructor(orchestrator: Orchestrator) {
    this.#orchestrator = orchestrator;
  }

  spawn(
    name: string,
    prompt: string,
    model: string | undefined,
    queue: Queue,
  ) {
    const sessionId = newSessionId();
    const info: BackgroundInfo = { name, sessionId, startTime: new Date() };
    this.#active.set(sessionId, info);

    log.debug({ name, sessionId }, "Starting background agent");

    this.#orchestrator.processRequest({ type: "background-agent", name, prompt, model }).then(
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
        this.#active.delete(sessionId);
        const result = (response.action === "send" ? response.message : "") || "[No output]";
        log.debug({ name, result }, "Background agent finished");
        queue.push({ type: "background-agent-result", name, result });
      },
      (err) => {
        this.#active.delete(sessionId);
        log.error({ name, err }, "Background agent failed");
        queue.push({ type: "background-agent-result", name, result: `[Error] ${err}` });
      },
    );
  }

  adopt(
    name: string,
    sessionId: string,
    completion: Promise<ClaudeResponse>,
    queue: Queue,
  ) {
    const info: BackgroundInfo = { name, sessionId, startTime: new Date() };
    this.#active.set(sessionId, info);

    log.debug({ name, sessionId }, "Adopting backgrounded task");

    completion.then(
      (response) => {
        this.#active.delete(sessionId);
        const result = (response.action === "send" ? response.message : "") || "[No output]";
        log.debug({ name, result }, "Adopted task finished");
        queue.push({ type: "background-agent-result", name, result, sessionId });
      },
      (err) => {
        this.#active.delete(sessionId);
        log.error({ name, err }, "Adopted task failed");
        queue.push({ type: "background-agent-result", name, result: `[Error] ${err}`, sessionId });
      },
    );
  }

  hasSessionId(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  list(): { name: string; sessionId: string; startTime: Date }[] {
    return [...this.#active.values()];
  }

  get size() {
    return this.#active.size;
  }
}
