import { createBot, sendResponse } from "./telegram";
import { runClaude, type ClaudeResponse } from "./claude";
import { createQueue } from "./queue";
import { startCron } from "./cron";

export interface AppConfig {
  botToken: string;
  authorizedChatId: string;
  sessionId: string;
  workspace: string;
  model?: string;
  runClaude?: (message: string, sessionId: string, model: string | undefined, workspace: string) => Promise<ClaudeResponse>;
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

  queue.setHandler(async (item) => {
    await bot.api.sendChatAction(config.authorizedChatId, "typing");
    const model = item.model ?? config.model;
    const response = await claude(item.message, config.sessionId, model, config.workspace);
    if (response.action === "send") {
      await sendResponse(bot, config.authorizedChatId, response.message || "[No output]");
    } else {
      console.log(`[silent] ${response.reason}`);
    }
  });

  bot.on("message:text", (ctx) => {
    if (ctx.chat.id.toString() !== config.authorizedChatId) return;
    if (ctx.message.text.startsWith("/")) return;

    queue.push({ message: ctx.message.text });
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
      startCron(config.workspace, queue);
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

