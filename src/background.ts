import { runClaude, newSessionId } from "./claude";

interface BackgroundInfo {
  name: string;
  sessionId: string;
  startTime: Date;
}

interface Queue {
  push(item: { message: string }): void;
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

      const systemPrompt = `You are a background agent named "${name}". Your output will be fed back to the main session. Be concise and focused.`;
      runClaudeFn(prompt, sessionId, model, workspace, systemPrompt).then(
        (response) => {
          active.delete(sessionId);
          const result = response.message || "[No output]";
          console.log(`[background] "${name}" finished: ${result}`);
          queue.push({ message: `[Background: ${name}] ${result}` });
        },
        (err) => {
          active.delete(sessionId);
          console.log(`[background] "${name}" failed: ${err}`);
          queue.push({
            message: `[Background: ${name}] [Error] ${err}`,
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
