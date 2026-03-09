import { createBackgroundManager } from "./background";
import { type ClaudeResponse, runClaude } from "./claude";
import { startCron } from "./cron";
import { createLogger } from "./logger";
import { CRON_TIMEOUT, MAIN_TIMEOUT, PROMPT_BACKGROUND_RESULT, PROMPT_CRON_EVENT, PROMPT_USER_MESSAGE } from "./prompts";
import { createQueue } from "./queue";
import { loadSettings, newSessionId, saveSettings } from "./settings";
import { createBot, downloadFile, sendFile, sendResponse } from "./telegram";

const log = createLogger("bot");

export interface AppConfig {
  botToken: string;
  authorizedChatId: string;
  workspace: string;
  model?: string;
  settingsDir?: string;
  runClaude?: (message: string, sessionFlag: "--resume" | "--session-id", sessionId: string, model: string | undefined, workspace: string, systemPrompt?: string, timeoutMs?: number, files?: string[]) => Promise<ClaudeResponse>;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.error({ name }, "Missing environment variable");
    process.exit(1);
  }
  return value;
}

export function createApp(config: AppConfig) {
  const bot = createBot(config.botToken);
  const queue = createQueue();
  const claude = config.runClaude ?? runClaude;
  const background = createBackgroundManager(claude);

  // Session state
  const settings = loadSettings(config.settingsDir);
  let sessionId: string;
  let sessionFlag: "--resume" | "--session-id";
  let sessionResolved = false;

  if (settings.sessionId) {
    sessionId = settings.sessionId;
    sessionFlag = "--resume";
  } else {
    sessionId = newSessionId();
    sessionFlag = "--session-id";
    saveSettings({ sessionId }, config.settingsDir);
    log.info({ sessionId }, "Created new session");
  }

  queue.setHandler(async (item) => {
    log.debug({ message: item.message }, "Incoming message");
    await bot.api.sendChatAction(config.authorizedChatId, "typing");
    const model = item.model ?? config.model;
    const isCron = item.source === "cron";
    const systemPrompt = isCron
      ? PROMPT_CRON_EVENT
      : item.source === "background"
        ? PROMPT_BACKGROUND_RESULT
        : PROMPT_USER_MESSAGE;
    const timeout = isCron ? CRON_TIMEOUT : MAIN_TIMEOUT;

    let response = await claude(item.message, sessionFlag, sessionId, model, config.workspace, systemPrompt, timeout, item.files);

    // Session resolution: if resume failed on first call, create new session
    if (!sessionResolved && sessionFlag === "--resume" && response.reason === "process-error") {
      sessionId = newSessionId();
      log.info({ sessionId }, "Resume failed, created new session");
      sessionFlag = "--session-id";
      saveSettings({ sessionId }, config.settingsDir);
      response = await claude(item.message, sessionFlag, sessionId, model, config.workspace, systemPrompt, timeout, item.files);
    }

    // Mark resolved on first success
    if (!sessionResolved && response.reason !== "process-error" && response.reason !== "timeout") {
      sessionResolved = true;
      sessionFlag = "--resume";
    }

    log.debug({ action: response.action, reason: response.reason, message: response.message.slice(0, 120) }, "Response");

    if (response.reason === "timeout") {
      if (isCron) {
        const cronName = item.name ?? "unknown";
        await sendResponse(bot, config.authorizedChatId, `Cron job "${cronName}" timed out after ${CRON_TIMEOUT / 1000} seconds.`);
      } else if (item.source !== "timeout") {
        await sendResponse(bot, config.authorizedChatId, "Request timed out. Retrying as a background task...");
        queue.push({ message: `[Timeout] The previous request timed out after ${MAIN_TIMEOUT / 1000} seconds. The user asked: "${item.message}". This task needs more time — spawn a background agent to handle it.`, source: "timeout" });
      } else {
        await sendResponse(bot, config.authorizedChatId, response.message || "[Error] Retry also timed out.");
      }
      return;
    }

    if (response.action === "background") {
      const name = response.name || "unnamed";
      background.spawn(name, response.message, model, config.workspace, queue);
      await sendResponse(bot, config.authorizedChatId, `Background agent "${name}" started.`);
    } else if (response.action === "send") {
      if (response.files?.length) {
        for (const filePath of response.files) {
          await sendFile(bot, config.authorizedChatId, filePath);
        }
      }
      await sendResponse(bot, config.authorizedChatId, response.message || "[No output]");
    } else {
      log.debug({ message: response.message || "(no message)" }, "Silent response");
    }
  });

  bot.command("chatid", (ctx) => {
    log.debug("Command /chatid");
    ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
  });

  bot.command("session", (ctx) => {
    log.debug("Command /session");
    ctx.reply(`Session: \`${sessionId}\``, { parse_mode: "Markdown" });
  });

  bot.command("bg", (ctx) => {
    log.debug("Command /bg");
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

  bot.on("message:photo", async (ctx) => {
    if (ctx.chat.id.toString() !== config.authorizedChatId) return;
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    try {
      const path = await downloadFile(bot, largest.file_id, config.botToken, "photo.jpg");
      queue.push({ message: ctx.message.caption ?? "", files: [path] });
    } catch (err) {
      log.error({ err }, "Photo download failed");
      queue.push({ message: `[File download failed: photo.jpg]\n${ctx.message.caption ?? ""}` });
    }
  });

  bot.on("message:document", async (ctx) => {
    if (ctx.chat.id.toString() !== config.authorizedChatId) return;
    const doc = ctx.message.document;
    const name = doc.file_name ?? "file";
    try {
      const path = await downloadFile(bot, doc.file_id, config.botToken, name);
      queue.push({ message: ctx.message.caption ?? "", files: [path] });
    } catch (err) {
      log.error({ err }, "Document download failed");
      queue.push({ message: `[File download failed: ${name}]\n${ctx.message.caption ?? ""}` });
    }
  });

  bot.on("message:text", (ctx) => {
    if (ctx.chat.id.toString() !== config.authorizedChatId) {
      log.debug({ chatId: ctx.chat.id }, "Unauthorized message");
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
    log.error({ err: err.message }, "Bot error");
  });

  return {
    bot,
    queue,
    start() {
      log.info("Starting macroclaw...");
      startCron(config.workspace, queue);
      bot.api.setMyCommands([
        { command: "chatid", description: "Show current chat ID" },
        { command: "session", description: "Show current session ID" },
        { command: "bg", description: "List background agents" },
      ]).catch((err) => log.error({ err }, "Failed to set commands"));
      bot.start({
        onStart: (botInfo) => {
          log.info({ username: botInfo.username, chatId: config.authorizedChatId, sessionId }, "Bot connected");
        },
      });
    },
  };
}
