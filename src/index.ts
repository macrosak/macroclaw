import { createBot, sendResponse } from "./telegram";
import { runClaude, type ClaudeResponse } from "./claude";
import { createQueue } from "./queue";
import { startCron } from "./cron";
import { createBackgroundManager } from "./background";
import { PROMPT_USER_MESSAGE, PROMPT_CRON_EVENT, PROMPT_BACKGROUND_RESULT } from "./prompts";

export interface AppConfig {
  botToken: string;
  authorizedChatId: string;
  sessionId: string;
  workspace: string;
  model?: string;
  runClaude?: (message: string, sessionId: string, model: string | undefined, workspace: string, systemPrompt?: string, timeoutMs?: number) => Promise<ClaudeResponse>;
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
  const background = createBackgroundManager(claude);

  queue.setHandler(async (item) => {
    console.log(`[incoming] ${item.message}`);
    await bot.api.sendChatAction(config.authorizedChatId, "typing");
    const model = item.model ?? config.model;
    const systemPrompt = item.message.startsWith("[Tool: cron/")
      ? PROMPT_CRON_EVENT
      : item.message.startsWith("[Background:")
        ? PROMPT_BACKGROUND_RESULT
        : PROMPT_USER_MESSAGE;
    const response = await claude(item.message, config.sessionId, model, config.workspace, systemPrompt);
    console.log(`[response] action=${response.action} reason=${response.reason} message=${response.message}`);
    if (response.action === "background") {
      const name = response.name || "unnamed";
      background.spawn(name, response.message, model, config.workspace, queue);
      await sendResponse(bot, config.authorizedChatId, `Background agent "${name}" started.`);
    } else if (response.action === "send") {
      await sendResponse(bot, config.authorizedChatId, response.message || "[No output]");
    } else {
      console.log(`[silent] ${response.message || "(no message)"}`);
    }
  });

  bot.command("chatid", (ctx) => {
    console.log("[command] /chatid");
    ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
  });

  bot.command("session", (ctx) => {
    console.log("[command] /session");
    ctx.reply(`Session: \`${config.sessionId}\``, { parse_mode: "Markdown" });
  });

  bot.command("bg", (ctx) => {
    console.log("[command] /bg");
    const agents = background.list();
    if (agents.length === 0) {
      ctx.reply("No background agents running.");
      return;
    }
    const lines = agents.map((a) => {
      const elapsed = Math.round((Date.now() - a.startTime.getTime()) / 1000);
      return `- ${a.name} (${elapsed}s)`;
    });
    ctx.reply(lines.join("\n"));
  });

  bot.on("message:text", (ctx) => {
    if (ctx.chat.id.toString() !== config.authorizedChatId) {
      console.log(`[unauthorized] chat_id=${ctx.chat.id}`);
      return;
    }

    const bgMatch = ctx.message.text.match(/^bg:\s*(.+)/s);
    if (bgMatch) {
      const prompt = bgMatch[1].trim();
      const name = prompt.slice(0, 30).replace(/\s+/g, "-");
      background.spawn(name, prompt, config.model, config.workspace, queue);
      ctx.reply(`Background agent "${name}" started.`);
      return;
    }

    queue.push({ message: ctx.message.text });
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
      bot.api.setMyCommands([
        { command: "chatid", description: "Show current chat ID" },
        { command: "session", description: "Show current session ID" },
        { command: "bg", description: "List background agents" },
      ]).catch((err) => console.error("Failed to set commands:", err));
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

