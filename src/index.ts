import { createBot, sendResponse } from "./telegram";
import { runClaude } from "./claude";

// --- Env validation ---
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in environment`);
    process.exit(1);
  }
  return value;
}

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const AUTHORIZED_CHAT_ID = requireEnv("AUTHORIZED_CHAT_ID");
const SESSION_ID = process.env.SESSION_ID || "main";

// --- Message queue ---
const queue: string[] = [];
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const message = queue.shift()!;
    try {
      await bot.api.sendChatAction(AUTHORIZED_CHAT_ID, "typing");
      const response = await runClaude(message, SESSION_ID);
      await sendResponse(bot, AUTHORIZED_CHAT_ID, response || "[No output]");
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : "Unknown error";
      await sendResponse(
        bot,
        AUTHORIZED_CHAT_ID,
        `[Error] ${errMsg}`,
      );
    }
  }

  processing = false;
}

// --- Bot setup ---
const bot = createBot(TELEGRAM_BOT_TOKEN);

bot.on("message:text", (ctx) => {
  if (ctx.chat.id.toString() !== AUTHORIZED_CHAT_ID) return;
  if (ctx.message.text.startsWith("/")) return;

  queue.push(ctx.message.text);
  processQueue();
});

bot.command("chatid", (ctx) => {
  ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
});

bot.command("session", (ctx) => {
  ctx.reply(`Session: \`${SESSION_ID}\``, { parse_mode: "Markdown" });
});

bot.catch((err) => {
  console.error("Bot error:", err.message);
});

console.log("Starting macroclaw...");
bot.start({
  onStart: (botInfo) => {
    console.log(`Bot connected: @${botInfo.username}`);
    console.log(`Authorized chat: ${AUTHORIZED_CHAT_ID}`);
    console.log(`Session: ${SESSION_ID}`);
  },
});
