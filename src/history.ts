import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createLogger } from "./logger";
import type { ClaudeResponse, OrchestratorRequest } from "./orchestrator";

const log = createLogger("history");

type HistoryEntry =
  | { ts: string; type: "prompt"; request: OrchestratorRequest }
  | { ts: string; type: "result"; response: ClaudeResponse };

const historyDir = resolve(process.env.HOME || "~", ".macroclaw", "history");

function todayFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(historyDir, `${date}.jsonl`);
}

async function append(entry: HistoryEntry): Promise<void> {
  try {
    await mkdir(historyDir, { recursive: true });
    await appendFile(todayFile(), `${JSON.stringify(entry)}\n`);
  } catch (err) {
    log.error({ err }, "Failed to write history entry");
  }
}

export async function logPrompt(request: OrchestratorRequest): Promise<void> {
  await append({ ts: new Date().toISOString(), type: "prompt", request });
}

export async function logResult(response: ClaudeResponse): Promise<void> {
  await append({ ts: new Date().toISOString(), type: "result", response });
}
