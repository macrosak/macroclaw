import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("sessions");

const sessionsSchema = z.object({
  mainSessions: z.record(z.string(), z.string()).default({}),
});

export type Sessions = z.infer<typeof sessionsSchema>;

const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

function migrateLegacy(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.mainSessionId === "string" && obj.mainSessions === undefined) {
      return { mainSessions: { admin: obj.mainSessionId } };
    }
  }
  return raw;
}

export function loadSessions(dir: string = defaultDir): Sessions {
  try {
    const path = join(dir, "sessions.json");
    if (!existsSync(path)) return { mainSessions: {} };
    const raw = migrateLegacy(JSON.parse(readFileSync(path, "utf-8")));
    return sessionsSchema.parse(raw);
  } catch (err) {
    log.warn({ err }, "Failed to load sessions.json, resetting to empty");
    return { mainSessions: {} };
  }
}

export function saveSessions(sessions: Sessions, dir: string = defaultDir): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sessions.json"), `${JSON.stringify(sessions, null, 2)}\n`);
}

export function getMainSession(chatName: string, dir: string = defaultDir): string | undefined {
  return loadSessions(dir).mainSessions[chatName];
}

export function setMainSession(chatName: string, sessionId: string, dir: string = defaultDir): void {
  const sessions = loadSessions(dir);
  sessions.mainSessions[chatName] = sessionId;
  saveSessions(sessions, dir);
}

export function clearMainSession(chatName: string, dir: string = defaultDir): void {
  const sessions = loadSessions(dir);
  if (chatName in sessions.mainSessions) {
    delete sessions.mainSessions[chatName];
    saveSessions(sessions, dir);
  }
}

export function newSessionId(): string {
  return randomUUID();
}
