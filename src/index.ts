
import { createBackgroundManager } from "./background";
import { type Claude, isDeferred } from "./claude";
import { startCron } from "./cron";
import { createLogger } from "./logger";
import { type ClaudeResponse, Orchestrator, type OrchestratorRequest } from "./orchestrator";
import { Queue } from "./queue";
import { createBot, downloadFile, sendFile, sendResponse } from "./telegram";

const log = createLogger("bot");

export interface AppConfig {
  botToken: string;
  authorizedChatId: string;
  workspace: string;
  model?: string;
  settingsDir?: string;
  claude?: Claude;
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
  const queue = new Queue<OrchestratorRequest>();
  const orchestrator = new Orchestrator({
    model: config.model,
    workspace: config.workspace,
    settingsDir: config.settingsDir,
    claude: config.claude,
  });
  const background = createBackgroundManager(orchestrator);

  async function handleResponse(response: ClaudeResponse) {
    if (response.action === "send") {
      if (response.files?.length) {
        for (const filePath of response.files) {
          await sendFile(bot, config.authorizedChatId, filePath);
        }
      }
      await sendResponse(bot, config.authorizedChatId, response.message || "[No output]", response.buttons);
    } else {
      log.debug("Silent response");
    }

    if (response.backgroundAgents?.length) {
      for (const agent of response.backgroundAgents) {
        const agentModel = agent.model ?? config.model;
        background.spawn(agent.name, agent.prompt, agentModel, config.workspace, queue);
        await sendResponse(bot, config.authorizedChatId, `Background agent "${agent.name}" started.`);
      }
    }
  }

  queue.setHandler(async (request) => {
    log.debug({ type: request.type }, "Incoming request");
    await bot.api.sendChatAction(config.authorizedChatId, "typing");

    // Background result with matching session ID: apply directly without Claude round-trip
    if (request.type === "background" && "sessionId" in request && request.sessionId === orchestrator.sessionId) {
      log.debug({ name: request.name }, "Background result on current session, applying directly");
      await sendResponse(bot, config.authorizedChatId, request.result || "[No output]");
      return;
    }

    // Fork session if a backgrounded task is running on the main session
    const needsFork = (request.type === "user" || request.type === "button") && background.hasSessionId(orchestrator.sessionId);

    const rawResponse = await orchestrator.processRequest(request, needsFork ? { forkSession: true } : undefined);
    if (isDeferred(rawResponse)) {
      const name = request.type === "user" ? request.message.slice(0, 30).replace(/\s+/g, "-")
        : request.type === "cron" ? `cron-${request.name}`
        : "task";
      log.info({ name, sessionId: rawResponse.sessionId }, "Request backgrounded due to timeout");
      await sendResponse(bot, config.authorizedChatId, "This is taking longer, continuing in the background.");
      background.adopt(name, rawResponse.sessionId, rawResponse.completion.then(
        (r) => {
          const msg = r.structuredOutput ? String((r.structuredOutput as Record<string, unknown>).message ?? "") : (r.result ?? "");
          return { action: "send" as const, message: msg, actionReason: "deferred-completed" };
        },
        (err) => ({ action: "send" as const, message: `[Error] ${err}`, actionReason: "deferred-failed" }),
      ), queue);
      return;
    }
    const response = rawResponse;
    log.debug({ action: response.action, actionReason: response.actionReason }, "Response");

    await handleResponse(response);
  });

  bot.command("chatid", (ctx) => {
    log.debug("Command /chatid");
    ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
  });

  bot.command("session", (ctx) => {
    log.debug("Command /session");
    ctx.reply(`Session: \`${orchestrator.sessionId}\``, { parse_mode: "Markdown" });
  });

  bot.command("bg", (ctx) => {
    if (ctx.chat.id.toString() !== config.authorizedChatId) return;
    const prompt = ctx.match?.trim();
    if (prompt) {
      log.debug({ prompt }, "Command /bg spawn");
      const name = prompt.slice(0, 30).replace(/\s+/g, "-");
      background.spawn(name, prompt, config.model, config.workspace, queue);
      ctx.reply(`Background agent "${name}" started.`);
      return;
    }
    log.debug("Command /bg list");
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
      queue.push({ type: "user", message: ctx.message.caption ?? "", files: [path] });
    } catch (err) {
      log.error({ err }, "Photo download failed");
      queue.push({ type: "user", message: `[File download failed: photo.jpg]\n${ctx.message.caption ?? ""}` });
    }
  });

  bot.on("message:document", async (ctx) => {
    if (ctx.chat.id.toString() !== config.authorizedChatId) return;
    const doc = ctx.message.document;
    const name = doc.file_name ?? "file";
    try {
      const path = await downloadFile(bot, doc.file_id, config.botToken, name);
      queue.push({ type: "user", message: ctx.message.caption ?? "", files: [path] });
    } catch (err) {
      log.error({ err }, "Document download failed");
      queue.push({ type: "user", message: `[File download failed: ${name}]\n${ctx.message.caption ?? ""}` });
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const label = ctx.callbackQuery.data;
    const original = ctx.callbackQuery.message?.text ?? "";
    await ctx.editMessageText(`${original}\n\n<i>Selected: ${label}</i>`, { parse_mode: "HTML" });
    if (ctx.chat?.id.toString() !== config.authorizedChatId) return;
    log.debug({ label }, "Button clicked");
    queue.push({ type: "button", label });
  });

  bot.on("message:text", (ctx) => {
    if (ctx.chat.id.toString() !== config.authorizedChatId) {
      log.debug({ chatId: ctx.chat.id }, "Unauthorized message");
      return;
    }

    queue.push({ type: "user", message: ctx.message.text });
  });

  bot.catch((err) => {
    log.error({ err }, "Bot error");
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
        { command: "bg", description: "List or spawn background agents" },
      ]).catch((err) => log.error({ err }, "Failed to set commands"));
      bot.start({
        onStart: (botInfo) => {
          log.info({ username: botInfo.username, chatId: config.authorizedChatId, sessionId: orchestrator.sessionId }, "Bot connected");
        },
      });
    },
  };
}
