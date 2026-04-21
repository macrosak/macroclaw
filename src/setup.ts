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
  install: (oauthToken?: string) => string;
}

export class SetupWizard {
  readonly #io: SetupIo;
  readonly #serviceInstaller?: ServiceInstaller;
  readonly #platform: string;
  #defaults: Record<string, unknown> = {};

  constructor(io: SetupIo, opts?: {
    serviceInstaller?: ServiceInstaller;
    platform?: string;
  }) {
    this.#io = io;
    this.#serviceInstaller = opts?.serviceInstaller;
    this.#platform = opts?.platform ?? process.platform;
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

      // Admin chat ID
      this.#io.write("Next, we need the admin chat ID. This is the bootstrap chat with full\n");
      this.#io.write("control — send /chatid to the bot in Telegram to get yours. Additional\n");
      this.#io.write("chats can be authorized at runtime via /chatsadd from the admin chat.\n\n");
      const defaultAdminChatId = this.#default("adminChatId");
      const adminChatIdPrompt = defaultAdminChatId ? `Admin chat ID [${defaultAdminChatId}]: ` : "Admin chat ID: ";
      const adminChatId = await this.#askValidated("adminChatId", adminChatIdPrompt, defaultAdminChatId);

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
      const defaultTimezone = this.#default("timeZone", detectedTz || "UTC");
      const timeZone = await this.#askValidated("timeZone", `Timezone [${defaultTimezone}]: `, defaultTimezone);

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
        adminChatId,
        model,
        workspace,
        timeZone,
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
    let oauthToken: string | undefined;
    if (this.#platform === "darwin") {
      this.#io.write("\nmacOS requires a long-lived OAuth token for the service.\n");
      this.#io.write("Run `claude setup-token` in another terminal, then paste the token here.\n\n");
      oauthToken = await this.#io.ask("OAuth token: ");
      if (!oauthToken) {
        this.#io.write("No token provided. Skipping service installation.\n");
        return;
      }
    }

    try {
      const svc = this.#serviceInstaller ?? new (await import("./system-service")).SystemServiceManager();
      const logCmd = svc.install(oauthToken);
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
