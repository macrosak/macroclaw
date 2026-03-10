import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createLogger } from "./logger";

const log = createLogger("history");

// Minimal types for history logging — intentionally kept broad to avoid coupling
type HistoryRequest = { type: string; [key: string]: unknown };
type HistoryResponse = { action: string; actionReason: string; [key: string]: unknown };

type HistoryEntry =
  | { ts: string; type: "prompt"; request: HistoryRequest }
  | { ts: string; type: "result"; response: HistoryResponse };

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

export async function logPrompt(request: HistoryRequest): Promise<void> {
  await append({ ts: new Date().toISOString(), type: "prompt", request });
}

export async function logResult(response: HistoryResponse): Promise<void> {
  await append({ ts: new Date().toISOString(), type: "result", response });
}
