import { createBot, sendResponse } from "./telegram";
import { runClaude } from "./claude";
import { createQueue } from "./queue";

export interface AppConfig {
  botToken: string;
  authorizedChatId: string;
  sessionId: string;
  model?: string;
  runClaude?: (message: string, sessionId: string, model?: string) => Promise<string>;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in environment`);
    process.exit(1);
  }
  return value;
}

export function createApp(config: AppConfig) {
  const bot = createBot(config.botToken);
  const queue = createQueue();
  const claude = config.runClaude ?? runClaude;

  queue.setHandler(async (message: string) => {
    try {
      await bot.api.sendChatAction(config.authorizedChatId, "typing");
      const response = await claude(message, config.sessionId, config.model);
      await sendResponse(bot, config.authorizedChatId, response || "[No output]");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      await sendResponse(bot, config.authorizedChatId, `[Error] ${errMsg}`);
    }
  });

  bot.on("message:text", (ctx) => {
    if (ctx.chat.id.toString() !== config.authorizedChatId) return;
    if (ctx.message.text.startsWith("/")) return;

    queue.push(ctx.message.text);
  });

  bot.command("chatid", (ctx) => {
    ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
  });

  bot.command("session", (ctx) => {
    ctx.reply(`Session: \`${config.sessionId}\``, { parse_mode: "Markdown" });
  });

  bot.catch((err) => {
    console.error("Bot error:", err.message);
  });

  return {
    bot,
    queue,
    start() {
      console.log("Starting macroclaw...");
      bot.start({
        onStart: (botInfo) => {
          console.log(`Bot connected: @${botInfo.username}`);
          console.log(`Authorized chat: ${config.authorizedChatId}`);
          console.log(`Session: ${config.sessionId}`);
        },
      });
    },
  };
}

