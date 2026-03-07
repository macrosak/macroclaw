import { newSessionId, runClaude } from "./claude";
import { BG_TIMEOUT, promptBackgroundAgent } from "./prompts";

interface BackgroundInfo {
  name: string;
  sessionId: string;
  startTime: Date;
}

interface Queue {
  push(item: { message: string; source?: string }): void;
}

export function createBackgroundManager(
  runClaudeFn: typeof runClaude = runClaude,
) {
  const active = new Map<string, BackgroundInfo>();

  return {
    spawn(
      name: string,
      prompt: string,
      model: string | undefined,
      workspace: string,
      queue: Queue,
    ) {
      const sessionId = newSessionId();
      const info: BackgroundInfo = { name, sessionId, startTime: new Date() };
      active.set(sessionId, info);

      console.log(`[background] Starting "${name}" (session ${sessionId})`);

      runClaudeFn(prompt, sessionId, model, workspace, promptBackgroundAgent(name), BG_TIMEOUT).then(
        (response) => {
          active.delete(sessionId);
          const result = response.message || "[No output]";
          console.log(`[background] "${name}" finished: ${result}`);
          queue.push({ message: `[Background: ${name}] ${result}`, source: "background" });
        },
        (err) => {
          active.delete(sessionId);
          console.log(`[background] "${name}" failed: ${err}`);
          queue.push({
            message: `[Background: ${name}] [Error] ${err}`,
            source: "background",
          });
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
