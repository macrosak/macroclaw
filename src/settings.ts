import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("settings");

const settingsSchema = z.object({
  sessionId: z.string().optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

export function loadSettings(dir: string = defaultDir): Settings {
  try {
    const path = join(dir, "settings.json");
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    return settingsSchema.parse(JSON.parse(raw));
  } catch (err) {
    log.warn({ err }, "Failed to load settings.json");
    return {};
  }
}

export function saveSettings(settings: Settings, dir: string = defaultDir): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

export function newSessionId(): string {
  return randomUUID();
}
