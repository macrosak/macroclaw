import type { Bot } from "grammy";
import { type Claude, isDeferred } from "./claude";
import { CronScheduler } from "./cron";
import { createLogger } from "./logger";
import { Orchestrator, type OrchestratorRequest } from "./orchestrator";
import { Queue } from "./queue";
import { createBot, downloadFile, sendFile, sendResponse } from "./telegram";

const log = createLogger("app");

export interface AppConfig {
  botToken: string;
  authorizedChatId: string;
  workspace: string;
  model?: string;
  settingsDir?: string;
  claude?: Claude;
}

export class App {
  #bot: Bot;
  #queue: Queue<OrchestratorRequest>;
  #orchestrator: Orchestrator;
  #config: AppConfig;

  constructor(config: AppConfig) {
    this.#config = config;
    this.#bot = createBot(config.botToken);
    this.#queue = new Queue<OrchestratorRequest>();
    this.#orchestrator = new Orchestrator({
      model: config.model,
      workspace: config.workspace,
      settingsDir: config.settingsDir,
      claude: config.claude,
    });

    this.#setupHandlers();
  }

  get bot() {
    return this.#bot;
  }

  get queue() {
    return this.#queue;
  }

  start() {
    log.info("Starting macroclaw...");
    const cron = new CronScheduler(this.#config.workspace, {
      onJob: (name, prompt, model) => this.#queue.push({ type: "cron", name, prompt, model }),
    });
    cron.start();
    this.#bot.api.setMyCommands([
      { command: "chatid", description: "Show current chat ID" },
      { command: "session", description: "Show current session ID" },
      { command: "bg", description: "List or spawn background agents" },
    ]).catch((err) => log.error({ err }, "Failed to set commands"));
    this.#bot.start({
      onStart: (botInfo) => {
        log.info({ username: botInfo.username, chatId: this.#config.authorizedChatId, sessionId: this.#orchestrator.sessionId }, "Bot connected");
      },
    });
  }

  async #handleResponse(response: Exclude<Awaited<ReturnType<Orchestrator["processRequest"]>>, { deferred: true }>) {
    if (response.action === "send") {
      if (response.files?.length) {
        for (const filePath of response.files) {
          await sendFile(this.#bot, this.#config.authorizedChatId, filePath);
        }
      }
      await sendResponse(this.#bot, this.#config.authorizedChatId, response.message || "[No output]", response.buttons);
    } else {
      log.debug("Silent response");
    }

    if (response.backgroundAgents?.length) {
      for (const agent of response.backgroundAgents) {
        const agentModel = agent.model ?? this.#config.model;
        this.#orchestrator.spawnBackground(agent.name, agent.prompt, agentModel, this.#queue);
        await sendResponse(this.#bot, this.#config.authorizedChatId, `Background agent "${agent.name}" started.`);
      }
    }
  }

  #setupHandlers() {
    this.#queue.setHandler(async (request) => {
      log.debug({ type: request.type }, "Incoming request");
      await this.#bot.api.sendChatAction(this.#config.authorizedChatId, "typing");

      // Background result with matching session ID: apply directly without Claude round-trip
      if (request.type === "background-agent-result" && "sessionId" in request && request.sessionId === this.#orchestrator.sessionId) {
        log.debug({ name: request.name }, "Background result on current session, applying directly");
        await this.#handleResponse(request.response);
        return;
      }

      // Fork session if a backgrounded task is running on the main session
      const needsFork = (request.type === "user" || request.type === "button") && this.#orchestrator.hasBackgroundSessionId(this.#orchestrator.sessionId);

      const rawResponse = await this.#orchestrator.processRequest(request, needsFork ? { forkSession: true } : undefined);
      if (isDeferred(rawResponse)) {
        const name = request.type === "user" ? request.message.slice(0, 30).replace(/\s+/g, "-")
          : request.type === "cron" ? `cron-${request.name}`
          : "task";
        log.info({ name, sessionId: rawResponse.sessionId }, "Request backgrounded due to timeout");
        await sendResponse(this.#bot, this.#config.authorizedChatId, "This is taking longer, continuing in the background.");
        this.#orchestrator.adoptBackground(name, rawResponse.sessionId, rawResponse.completion.then(
          (r) => {
            const msg = r.structuredOutput ? String((r.structuredOutput as Record<string, unknown>).message ?? "") : (r.result ?? "");
            return { action: "send" as const, message: msg, actionReason: "deferred-completed" };
          },
          (err) => ({ action: "send" as const, message: `[Error] ${err}`, actionReason: "deferred-failed" }),
        ), this.#queue);
        return;
      }
      const response = rawResponse;
      log.debug({ action: response.action, actionReason: response.actionReason }, "Response");

      await this.#handleResponse(response);
    });

    this.#bot.command("chatid", (ctx) => {
      log.debug("Command /chatid");
      ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
    });

    this.#bot.command("session", (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      log.debug("Command /session");
      ctx.reply(`Session: \`${this.#orchestrator.sessionId}\``, { parse_mode: "Markdown" });
    });

    this.#bot.command("bg", (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      const prompt = ctx.match?.trim();
      if (prompt) {
        log.debug({ prompt }, "Command /bg spawn");
        const name = prompt.slice(0, 30).replace(/\s+/g, "-");
        this.#orchestrator.spawnBackground(name, prompt, this.#config.model, this.#queue);
        ctx.reply(`Background agent "${name}" started.`);
        return;
      }
      log.debug("Command /bg list");
      const agents = this.#orchestrator.listBackground();
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

    this.#bot.on("message:photo", async (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      try {
        const path = await downloadFile(this.#bot, largest.file_id, this.#config.botToken, "photo.jpg");
        this.#queue.push({ type: "user", message: ctx.message.caption ?? "", files: [path] });
      } catch (err) {
        log.error({ err }, "Photo download failed");
        this.#queue.push({ type: "user", message: `[File download failed: photo.jpg]\n${ctx.message.caption ?? ""}` });
      }
    });

    this.#bot.on("message:document", async (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      const doc = ctx.message.document;
      const name = doc.file_name ?? "file";
      try {
        const path = await downloadFile(this.#bot, doc.file_id, this.#config.botToken, name);
        this.#queue.push({ type: "user", message: ctx.message.caption ?? "", files: [path] });
      } catch (err) {
        log.error({ err }, "Document download failed");
        this.#queue.push({ type: "user", message: `[File download failed: ${name}]\n${ctx.message.caption ?? ""}` });
      }
    });

    this.#bot.on("callback_query:data", async (ctx) => {
      await ctx.answerCallbackQuery();
      const label = ctx.callbackQuery.data;
      const original = ctx.callbackQuery.message?.text ?? "";
      await ctx.editMessageText(`${original}\n\n<i>Selected: ${label}</i>`, { parse_mode: "HTML" });
      if (ctx.chat?.id.toString() !== this.#config.authorizedChatId) return;
      log.debug({ label }, "Button clicked");
      this.#queue.push({ type: "button", label });
    });

    this.#bot.on("message:text", (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) {
        log.debug({ chatId: ctx.chat.id }, "Unauthorized message");
        return;
      }

      this.#queue.push({ type: "user", message: ctx.message.text });
    });

    this.#bot.catch((err) => {
      log.error({ err }, "Bot error");
    });
  }
}
