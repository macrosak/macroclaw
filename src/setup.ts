import { Bot } from "grammy";
import { createLogger } from "./logger";
import { type Settings, settingsSchema } from "./settings";

const log = createLogger("setup");

export interface SetupIO {
  ask: (question: string) => Promise<string>;
  write: (msg: string) => void;
}

async function startSetupBot(token: string): Promise<Bot> {
  const bot = new Bot(token);
  bot.command("chatid", (ctx) => {
    ctx.reply(`Your chat ID is: ${ctx.chat.id}`);
  });
  bot.catch((err) => {
    log.debug({ err }, "Setup bot error");
  });

  await bot.init();
  log.info({ username: bot.botInfo.username }, "Setup bot started");

  bot.start();
  return bot;
}

export async function runSetupWizard(io: SetupIO): Promise<Settings> {
  const { ask, write } = io;

  write("\n=== Macroclaw Setup ===\n\n");

  // Bot token
  const defaultToken = process.env.TELEGRAM_BOT_TOKEN || "";
  const tokenPrompt = defaultToken ? `Bot token [${defaultToken.slice(0, 4)}...]: ` : "Bot token: ";
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
  const defaultChatId = process.env.AUTHORIZED_CHAT_ID || "";
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
  const defaultModel = process.env.MODEL || "sonnet";
  const model = await ask(`Model [${defaultModel}]: `) || defaultModel;

  // Workspace
  const defaultWorkspace = process.env.WORKSPACE || "~/.macroclaw-workspace";
  const workspace = await ask(`Workspace [${defaultWorkspace}]: `) || defaultWorkspace;

  // OpenAI API key
  const defaultOpenai = process.env.OPENAI_API_KEY || "";
  const openaiPrompt = defaultOpenai ? `OpenAI API key [${defaultOpenai.slice(0, 4)}...] (optional): ` : "OpenAI API key (optional): ";
  const openaiApiKey = await ask(openaiPrompt) || defaultOpenai || undefined;

  const settings: Settings = settingsSchema.parse({
    botToken,
    chatId,
    model,
    workspace,
    openaiApiKey,
    logLevel: "debug",
  });

  write("\nSetup complete!\n\n");

  return settings;
}
