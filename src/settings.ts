import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { IANAZone } from "luxon";
import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("settings");

export const settingsSchema = z.object({
  botToken: z.string().trim(),
  adminChatId: z.string().trim().regex(/^-?\d+$/, "Must be a numeric Telegram chat ID"),
  model: z.string().trim().pipe(z.enum(["haiku", "sonnet", "opus"])).default("sonnet"),
  workspace: z.string().trim().default("~/.macroclaw-workspace"),
  timeZone: z.string().trim().refine((tz) => IANAZone.isValidZone(tz), "Must be a valid IANA timezone").default("UTC"),
  openaiApiKey: z.string().trim().optional(),
  logLevel: z.string().trim().pipe(z.enum(["debug", "info", "warn", "error"])).default("info"),
  pinoramaUrl: z.string().trim().optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

export function maskValue(key: string, value: string | undefined): string {
  if (value === undefined) return "(not set)";
  if (key === "botToken" || key === "openaiApiKey") {
    return value.length > 4 ? `****${value.slice(-4)}` : "****";
  }
  return value;
}

const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

function migrateLegacy(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.chatId === "string" && obj.adminChatId === undefined) {
      const { chatId, ...rest } = obj;
      log.warn("settings.json uses legacy `chatId` field; migrating to `adminChatId`");
      return { ...rest, adminChatId: chatId };
    }
  }
  return raw;
}

export class SettingsManager {
  readonly #dir: string;

  static readonly envMapping: Record<keyof Settings, string> = {
    botToken: "TELEGRAM_BOT_TOKEN",
    adminChatId: "ADMIN_CHAT_ID",
    model: "MODEL",
    workspace: "WORKSPACE",
    timeZone: "TIMEZONE",
    openaiApiKey: "OPENAI_API_KEY",
    logLevel: "LOG_LEVEL",
    pinoramaUrl: "PINORAMA_URL",
  };

  /** Legacy env var names still honored as fallbacks for one release. */
  static readonly envLegacy: Partial<Record<keyof Settings, string>> = {
    adminChatId: "AUTHORIZED_CHAT_ID",
  };

  constructor(dir: string = defaultDir) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  load(): Settings {
    const path = join(this.#dir, "settings.json");
    if (!existsSync(path)) {
      log.error({ path }, "settings.json not found. Run `macroclaw setup` first.");
      process.exit(1);
    }

    let raw: unknown;
    try {
      raw = migrateLegacy(JSON.parse(readFileSync(path, "utf-8")));
    } catch {
      raw = null;
    }

    const result = settingsSchema.safeParse(raw);
    if (!result.success) {
      log.error({ issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, "settings.json validation failed");
      process.exit(1);
    }

    return result.data;
  }

  loadRaw(): Record<string, unknown> | null {
    const path = join(this.#dir, "settings.json");
    if (!existsSync(path)) return null;
    try {
      const raw = migrateLegacy(JSON.parse(readFileSync(path, "utf-8")));
      return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  save(settings: Settings): void {
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(join(this.#dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  }

  applyEnvOverrides(settings: Settings): { settings: Settings; overrides: Set<string> } {
    const merged: Record<string, unknown> = { ...settings };
    const overrides = new Set<string>();

    for (const [key, envVar] of Object.entries(SettingsManager.envMapping)) {
      const value = process.env[envVar];
      if (value !== undefined) {
        merged[key] = value;
        overrides.add(key);
        continue;
      }
      const legacy = SettingsManager.envLegacy[key as keyof Settings];
      if (legacy && process.env[legacy] !== undefined) {
        merged[key] = process.env[legacy];
        overrides.add(key);
        log.warn({ legacy, preferred: envVar }, "using legacy env var; rename to the new one");
      }
    }

    const result = settingsSchema.safeParse(merged);
    if (!result.success) {
      log.error({ issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, "settings env override validation failed");
      process.exit(1);
    }

    return { settings: result.data, overrides };
  }

  print(settings: Settings, overrides: Set<string>): void {
    const lines = ["Settings:"];
    for (const key of Object.keys(SettingsManager.envMapping) as (keyof Settings)[]) {
      const value = settings[key];
      const masked = maskValue(key, value);
      const suffix = overrides.has(key) ? " (env)" : "";
      lines.push(`  ${key}: ${masked}${suffix}`);
    }
    log.info(lines.join("\n"));
  }
}
