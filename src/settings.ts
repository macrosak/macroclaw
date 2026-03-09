import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Settings {
  sessionId?: string;
}

const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

export function loadSettings(dir: string = defaultDir): Settings {
  try {
    const path = join(dir, "settings.json");
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch {
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
