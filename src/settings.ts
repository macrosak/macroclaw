import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("settings");

export const settingsSchema = z.object({
  botToken: z.string(),
  chatId: z.string().regex(/^-?\d+$/, "Must be a numeric Telegram chat ID"),
  model: z.enum(["haiku", "sonnet", "opus"]).default("sonnet"),
  workspace: z.string().default("~/.macroclaw-workspace"),
  openaiApiKey: z.string().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
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

// --- Env var overrides ---

const envMapping: Record<keyof Settings, string> = {
  botToken: "TELEGRAM_BOT_TOKEN",
  chatId: "AUTHORIZED_CHAT_ID",
  model: "MODEL",
  workspace: "WORKSPACE",
  openaiApiKey: "OPENAI_API_KEY",
  logLevel: "LOG_LEVEL",
  pinoramaUrl: "PINORAMA_URL",
};

export function applyEnvOverrides(settings: Settings): { settings: Settings; overrides: Set<string> } {
  const merged = { ...settings };
  const overrides = new Set<string>();

  for (const [key, envVar] of Object.entries(envMapping)) {
    const value = process.env[envVar];
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
      overrides.add(key);
    }
  }

  return { settings: merged, overrides };
}

// --- Startup log ---

export function maskValue(key: string, value: string | undefined): string {
  if (value === undefined) return "(not set)";
  if (key === "botToken" || key === "openaiApiKey") {
    return value.length > 4 ? `****${value.slice(-4)}` : "****";
  }
  return value;
}

export function printSettings(settings: Settings, overrides: Set<string>): void {
  const lines = ["Settings:"];
  for (const key of Object.keys(envMapping) as (keyof Settings)[]) {
    const value = settings[key];
    const masked = maskValue(key, value);
    const suffix = overrides.has(key) ? " (env)" : "";
    lines.push(`  ${key}: ${masked}${suffix}`);
  }
  log.info(lines.join("\n"));
}
