import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("sessions");

const sessionsSchema = z.object({
  mainSessionId: z.string().optional(),
});

export type Sessions = z.infer<typeof sessionsSchema>;

const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

export function loadSessions(dir: string = defaultDir): Sessions {
  try {
    const path = join(dir, "sessions.json");
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    return sessionsSchema.parse(JSON.parse(raw));
  } catch (err) {
    log.warn({ err }, "Failed to load sessions.json, resetting to empty");
    return {};
  }
}

export function saveSessions(sessions: Sessions, dir: string = defaultDir): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sessions.json"), `${JSON.stringify(sessions, null, 2)}\n`);
}

export function newSessionId(): string {
  return randomUUID();
}

/**
 * Migrate sessionId from settings.json to sessions.json (one-time migration).
 * If settings.json has a sessionId and sessions.json doesn't exist or has no mainSessionId,
 * copy it over.
 */
export function migrateSessionFromSettings(dir: string = defaultDir): void {
  const sessionsPath = join(dir, "sessions.json");
  const settingsPath = join(dir, "settings.json");

  // Only migrate if sessions.json doesn't exist yet
  if (existsSync(sessionsPath)) return;
  if (!existsSync(settingsPath)) return;

  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (typeof raw.sessionId === "string") {
      log.info("Migrating sessionId from settings.json to sessions.json");
      saveSessions({ mainSessionId: raw.sessionId }, dir);

      // Remove sessionId from settings.json
      const { sessionId: _, ...rest } = raw;
      writeFileSync(settingsPath, `${JSON.stringify(rest, null, 2)}\n`);
    }
  } catch {
    // Settings file corrupt — skip migration
  }
}
