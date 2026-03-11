import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("settings");

export const settingsSchema = z.object({
  botToken: z.string(),
  chatId: z.string(),
  model: z.string().default("sonnet"),
  workspace: z.string().default("~/.macroclaw-workspace"),
  openaiApiKey: z.string().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("debug"),
  pinoramaUrl: z.string().optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

export function loadSettings(dir: string = defaultDir): Settings {
  const path = join(dir, "settings.json");
  if (!existsSync(path)) return null as unknown as Settings;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    log.error({ err }, "settings.json is not valid JSON");
    process.exit(1);
  }

  const result = settingsSchema.safeParse(raw);
  if (!result.success) {
    log.error({ issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, "settings.json validation failed");
    process.exit(1);
  }

  return result.data;
}

export function saveSettings(settings: Settings, dir: string = defaultDir): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}
