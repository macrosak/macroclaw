import { execSync } from "node:child_process";
import { Bot } from "grammy";
import { createLogger } from "./logger";
import { maskValue, type Settings, settingsSchema } from "./settings";

const log = createLogger("setup");

export interface SetupIO {
  ask: (question: string) => Promise<string>;
  write: (msg: string) => void;
  close?: () => void;
}

async function startSetupBot(token: string): Promise<Bot> {
  const bot = new Bot(token);
  bot.command("chatid", (ctx) => {
    ctx.reply(ctx.chat.id.toString());
  });
  bot.catch((err) => {
    log.debug({ err }, "Setup bot error");
  });

  await bot.init();
  await bot.api.setMyCommands([{ command: "chatid", description: "Get your chat ID" }]);
  bot.start();
  return bot;
}

export interface ServiceInstaller {
  install: (oauthToken?: string) => string;
}

export interface SetupDefaults {
  botToken?: string;
  chatId?: string;
  model?: string;
  workspace?: string;
  openaiApiKey?: string;
}

export function resolveClaudePath(exec: (cmd: string) => string = (cmd) => execSync(cmd, { encoding: "utf-8" })): string {
  try {
    return exec("which claude").trim();
  } catch {
    throw new Error("Claude Code CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code");
  }
}

export async function runSetupWizard(io: SetupIO, opts?: { defaults?: SetupDefaults; serviceInstaller?: ServiceInstaller; onSettingsReady?: (settings: Settings) => void; resolveClaude?: () => string; platform?: string }): Promise<Settings> {
  const { ask, write } = io;
  const prev = opts?.defaults ?? {};

  // Fail fast if claude CLI is not installed
  const resolve = opts?.resolveClaude ?? resolveClaudePath;
  resolve();

  write("\n=== Macroclaw ===\n\n");
  write("Personal AI assistant, powered by Claude Code, delivered through Telegram.\n\n");
  write("=== Setup ===\n\n");

  // Bot token
  write("First, set up a Telegram bot:\n");
  write("  1. Open Telegram and message @BotFather\n");
  write("  2. Send /newbot and follow the instructions\n");
  write("  3. Copy the token it gives you (looks like 123456:ABC-DEF...)\n\n");
  const defaultToken = prev.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
  const tokenPrompt = defaultToken ? `Bot token [${maskValue("botToken", defaultToken)}]: ` : "Bot token: ";
  let botToken = await ask(tokenPrompt) || defaultToken;

  // Validate token by starting a temporary bot
  let setupBot: Bot | null = null;
  while (true) {
    if (!botToken) {
      botToken = await ask("Bot token (required): ");
      continue;
    }
    try {
      setupBot = await startSetupBot(botToken);
      write(`Bot @${setupBot.botInfo.username} connected. Send /chatid to the bot to get your chat ID.\n`);
      break;
    } catch {
      write("Invalid bot token. Please try again.\n");
      botToken = await ask("Bot token: ");
    }
  }

  // Chat ID
  const defaultChatId = prev.chatId || process.env.AUTHORIZED_CHAT_ID || "";
  const chatIdPrompt = defaultChatId ? `Chat ID [${defaultChatId}]: ` : "Chat ID: ";
  let chatId = await ask(chatIdPrompt) || defaultChatId;
  while (!chatId) {
    chatId = await ask("Chat ID (required): ");
  }

  // Stop setup bot
  if (setupBot) {
    await setupBot.stop();
  }

  // Model
  const defaultModel = prev.model || process.env.MODEL || "sonnet";
  const model = await ask(`Model [${defaultModel}]: `) || defaultModel;

  // Workspace
  const defaultWorkspace = prev.workspace || process.env.WORKSPACE || "~/.macroclaw-workspace";
  const workspace = await ask(`Workspace [${defaultWorkspace}]: `) || defaultWorkspace;

  // OpenAI API key
  write("\nMacroclaw uses OpenAI's Whisper API to transcribe voice messages.\n");
  write("Without this key, voice messages will be ignored.\n\n");
  const defaultOpenai = prev.openaiApiKey || process.env.OPENAI_API_KEY || "";
  const openaiPrompt = defaultOpenai ? `OpenAI API key [${maskValue("openaiApiKey", defaultOpenai)}] (optional): ` : "OpenAI API key (optional): ";
  const openaiApiKey = await ask(openaiPrompt) || defaultOpenai || undefined;

  const settings: Settings = settingsSchema.parse({
    botToken,
    chatId,
    model,
    workspace,
    openaiApiKey,
    logLevel: "debug",
  });

  // Persist settings before service install prompt so ServiceManager can find them
  opts?.onSettingsReady?.(settings);

  write("\nSetup complete!\n\n");

  // Optional service installation
  const installAnswer = await ask("Install as a system service? [Y/n]: ");
  let oauthToken: string | undefined;
  if (installAnswer.toLowerCase() !== "n" && installAnswer.toLowerCase() !== "no") {
    if ((opts?.platform ?? process.platform) === "darwin") {
      write("\nmacOS requires a long-lived OAuth token for the service.\n");
      write("Run `claude setup-token` in another terminal, then paste the token here.\n\n");
      oauthToken = await ask("OAuth token: ");
      if (!oauthToken) {
        write("No token provided. Skipping service installation.\n");
        io.close?.();
        return settings;
      }
    }
  }
  // Release terminal control before sudo may prompt for a password
  io.close?.();
  if (installAnswer.toLowerCase() !== "n" && installAnswer.toLowerCase() !== "no") {
    try {
      const svc = opts?.serviceInstaller ?? new (await import("./service")).ServiceManager();
      const logCmd = svc.install(oauthToken);
      write(`Service installed and started. Check logs:\n  ${logCmd}\n`);
    } catch (err) {
      write(`Service installation failed: ${(err as Error).message}\n`);
    }
  }

  return settings;
}
