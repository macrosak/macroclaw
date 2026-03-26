import { execSync } from "node:child_process";
import { Bot } from "grammy";
import { createLogger } from "./logger";
import { maskValue, type Settings, SettingsManager, settingsSchema } from "./settings";

const log = createLogger("setup");

type SetupField = keyof typeof settingsSchema.shape;

export interface SetupIo {
  open: () => void;
  close: () => void;
  ask: (question: string) => Promise<string>;
  write: (msg: string) => void;
}

export interface ServiceInstaller {
  install: () => string;
}

export class SetupWizard {
  readonly #io: SetupIo;
  readonly #serviceInstaller?: ServiceInstaller;
  #defaults: Record<string, unknown> = {};

  constructor(io: SetupIo, opts?: {
    serviceInstaller?: ServiceInstaller;
  }) {
    this.#io = io;
    this.#serviceInstaller = opts?.serviceInstaller;
  }

  #resolveClaudePath(): void {
    try {
      execSync("which claude", { encoding: "utf-8" });
    } catch {
      throw new Error("Claude Code CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code");
    }
  }

  #default(key: string, fallback?: string): string {
    const envVar = SettingsManager.envMapping[key as keyof Settings];
    return (this.#defaults[key] as string) || (envVar && process.env[envVar]) || fallback || "";
  }

  async collectSettings(defaults?: Record<string, unknown>): Promise<Settings> {
    this.#defaults = defaults ?? {};
    this.#io.open();
    try {
      this.#resolveClaudePath();

      this.#io.write("\n=== Macroclaw ===\n\n");
      this.#io.write("Personal AI assistant, powered by Claude Code, delivered through Telegram.\n\n");
      this.#io.write("=== Setup ===\n\n");

      // Bot token
      this.#io.write("First, set up a Telegram bot:\n");
      this.#io.write("  1. Open Telegram and message @BotFather\n");
      this.#io.write("  2. Send /newbot and follow the instructions\n");
      this.#io.write("  3. Copy the token it gives you (looks like 123456:ABC-DEF...)\n\n");
      const { botToken, bot } = await this.#askBotToken();

      // Chat ID
      this.#io.write("Next, we need a chat ID. Macroclaw only accepts messages from a single\n");
      this.#io.write("authorized chat — send /chatid to the bot in Telegram to get yours.\n\n");
      const defaultChatId = this.#default("chatId");
      const chatIdPrompt = defaultChatId ? `Chat ID [${defaultChatId}]: ` : "Chat ID: ";
      const chatId = await this.#askValidated("chatId", chatIdPrompt, defaultChatId);

      // Stop setup bot after chat ID is collected
      await bot.stop();

      // Model
      this.#io.write("\nThe default Claude model for conversations (haiku, sonnet, opus).\n\n");
      const defaultModel = this.#default("model", "sonnet");
      const model = await this.#askValidated("model", `Model [${defaultModel}]: `, defaultModel);

      // Workspace
      this.#io.write("\nThe workspace directory where Claude Code runs — instructions, skills,\n");
      this.#io.write("memory, and scheduled events all live here.\n\n");
      const defaultWorkspace = this.#default("workspace", "~/.macroclaw-workspace");
      const workspace = await this.#askValidated("workspace", `Workspace [${defaultWorkspace}]: `, defaultWorkspace);

      // Timezone
      this.#io.write("\nLocal timezone for the agent's clock and scheduled events.\n");
      this.#io.write("Use an IANA timezone name (e.g. Europe/Prague, America/New_York, UTC).\n\n");
      const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const defaultTimezone = this.#default("timezone", detectedTz || "UTC");
      const timezone = await this.#askValidated("timezone", `Timezone [${defaultTimezone}]: `, defaultTimezone);

      // OpenAI API key
      this.#io.write("\nMacroclaw uses OpenAI's Whisper API to transcribe voice messages.\n");
      this.#io.write("Without this key, voice messages will be ignored.\n\n");
      const defaultOpenai = this.#default("openaiApiKey");
      const openaiPrompt = defaultOpenai ? `OpenAI API key [${maskValue("openaiApiKey", defaultOpenai)}] (optional): ` : "OpenAI API key (optional): ";
      const openaiApiKey = await this.#askValidated("openaiApiKey", openaiPrompt, defaultOpenai) || undefined;

      // Log level (non interactive)
      const logLevel = this.#default("logLevel");

      const settings: Settings = settingsSchema.parse({
        botToken,
        chatId,
        model,
        workspace,
        timezone,
        openaiApiKey,
        ...(logLevel && { logLevel }),
      });

      this.#io.write("\nSetup complete!\n\n");
      return settings;
    } finally {
      this.#io.close();
    }
  }

  async installService(): Promise<void> {
    this.#io.open();
    try {
      const installAnswer = await this.#io.ask("Install as a service? [Y/n]:");
      if (installAnswer.toLowerCase() === "n" || installAnswer.toLowerCase() === "no") return;

      await this.#doInstallService();
    } finally {
      this.#io.close();
    }
  }

  async forceInstallService(): Promise<void> {
    this.#io.open();
    try {
      await this.#doInstallService();
    } finally {
      this.#io.close();
    }
  }

  async #doInstallService(): Promise<void> {
    try {
      const svc = this.#serviceInstaller ?? new (await import("./system-service")).SystemServiceManager();
      const logCmd = svc.install();
      this.#io.write(`Service installed and started. Check logs:\n  ${logCmd}\n`);
    } catch (err) {
      this.#io.write(`Service installation failed: ${(err as Error).message}\n`);
    }
  }

  async #askValidated(field: SetupField, prompt: string, fallback: string): Promise<string> {
    const schema = settingsSchema.shape[field];
    let value = await this.#io.ask(prompt) || fallback;
    while (true) {
      const result = schema.safeParse(value);
      if (result.success) return result.data as string;
      const issue = result.error?.issues?.[0];
      this.#io.write(`Invalid value: ${issue?.message ?? "validation failed"}. Please try again.\n`);
      value = await this.#io.ask(prompt) || fallback;
    }
  }

  async #startBot(token: string): Promise<Bot> {
    const bot = new Bot(token);
    bot.command("chatid", (ctx) => {
      ctx.reply(ctx.chat.id.toString());
    });
    bot.catch((err) => {
      log.debug({ err }, "Setup bot error");
    });

    await bot.init();
    await bot.api.setMyCommands([{ command: "chatid", description: "Get your chat ID" }]);
    // Fire-and-forget: long-polling loop, stop() aborts with "Aborted delay"
    void bot.start().catch(() => {});
    return bot;
  }

  async #askBotToken(): Promise<{ botToken: string; bot: Bot }> {
    const defaultToken = this.#default("botToken");
    const tokenPrompt = defaultToken ? `Bot token [${maskValue("botToken", defaultToken)}]: ` : "Bot token: ";
    let botToken = await this.#askValidated("botToken", tokenPrompt, defaultToken);

    // Validate token by starting a temporary bot
    while (true) {
      if (!botToken) {
        botToken = await this.#askValidated("botToken", "Bot token (required): ", "");
        continue;
      }
      try {
        const bot = await this.#startBot(botToken);
        this.#io.write(`\nBot @${bot.botInfo.username} connected.\n\n`);
        return { botToken, bot };
      } catch {
        this.#io.write("Invalid bot token. Please try again.\n");
        botToken = await this.#io.ask("Bot token: ");
      }
    }
  }
}
