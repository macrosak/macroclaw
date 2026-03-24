import type { Bot } from "grammy";
import { createLogger } from "./logger";
import { type Claude, Orchestrator, type OrchestratorResponse } from "./orchestrator";
import { Scheduler } from "./scheduler";
import type { SpeechToText } from "./speech-to-text";
import { createBot, downloadFile, sendFile, sendResponse } from "./telegram";

const log = createLogger("app");

export interface AppConfig {
  botToken: string;
  authorizedChatId: string;
  workspace: string;
  model?: string;
  settingsDir?: string;
  claude?: Claude;
  stt?: SpeechToText;
  healthCheckInterval?: number;
}

export class App {
  #bot: Bot;
  #orchestrator: Orchestrator;
  #config: AppConfig;

  constructor(config: AppConfig) {
    this.#config = config;
    this.#bot = createBot(config.botToken);
    this.#orchestrator = new Orchestrator({
      model: config.model,
      workspace: config.workspace,
      settingsDir: config.settingsDir,
      claude: config.claude,
      healthCheckInterval: config.healthCheckInterval,
      onResponse: (r) => this.#deliverResponse(r),
    });

    this.#setupHandlers();
  }

  get bot() {
    return this.#bot;
  }

  async dispose(): Promise<void> {
    await this.#orchestrator.dispose();
  }

  start() {
    log.info("Starting macroclaw...");
    const scheduler = new Scheduler(this.#config.workspace, {
      onJob: (name, prompt, model, missed) => this.#orchestrator.handleCron(name, prompt, model, missed),
    });
    scheduler.start();
    this.#bot.api.setMyCommands([
      { command: "chatid", description: "Show current chat ID" },
      { command: "bg", description: "Spawn a background agent" },
      { command: "sessions", description: "List running sessions" },
      { command: "restart", description: "Restart the main Claude session" },
    ]).catch((err) => log.error({ err }, "Failed to set commands"));
    this.#bot.start({
      onStart: (botInfo) => {
        log.info({ username: botInfo.username, chatId: this.#config.authorizedChatId }, "Bot connected");
      },
    });
  }

  async #deliverResponse(response: OrchestratorResponse) {
    if (response.files?.length) {
      for (const filePath of response.files) {
        await sendFile(this.#bot, this.#config.authorizedChatId, filePath);
      }
    }
    await sendResponse(this.#bot, this.#config.authorizedChatId, response.message, response.buttons);
  }

  #setupHandlers() {
    this.#bot.command("chatid", (ctx) => {
      log.debug("Command /chatid");
      ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
    });

    this.#bot.command("bg", (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      const prompt = ctx.match?.trim();
      if (!prompt) {
        log.debug("Command /bg without prompt");
        sendResponse(this.#bot, this.#config.authorizedChatId, "Usage: /bg &lt;prompt&gt;");
        return;
      }
      log.debug({ prompt }, "Command /bg spawn");
      this.#orchestrator.handleBackgroundCommand(prompt);
    });

    this.#bot.command("sessions", (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      log.debug("Command /sessions");
      this.#orchestrator.handleSessions();
    });

    this.#bot.command("restart", (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      log.debug("Command /restart");
      this.#orchestrator.handleRestart();
    });

    this.#bot.on("message:photo", async (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      try {
        const path = await downloadFile(this.#bot, largest.file_id, this.#config.botToken, "photo.jpg");
        this.#orchestrator.handleMessage(ctx.message.caption ?? "", [path]);
      } catch (err) {
        log.error({ err }, "Photo download failed");
        this.#orchestrator.handleMessage(`[File download failed: photo.jpg]\n${ctx.message.caption ?? ""}`);
      }
    });

    this.#bot.on("message:document", async (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      const doc = ctx.message.document;
      const name = doc.file_name ?? "file";
      try {
        const path = await downloadFile(this.#bot, doc.file_id, this.#config.botToken, name);
        this.#orchestrator.handleMessage(ctx.message.caption ?? "", [path]);
      } catch (err) {
        log.error({ err }, "Document download failed");
        this.#orchestrator.handleMessage(`[File download failed: ${name}]\n${ctx.message.caption ?? ""}`);
      }
    });

    this.#bot.on("message:voice", async (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      if (!this.#config.stt) {
        await sendResponse(this.#bot, this.#config.authorizedChatId, "[Voice messages not available — set openaiApiKey in settings to enable]");
        return;
      }
      try {
        const path = await downloadFile(this.#bot, ctx.message.voice.file_id, this.#config.botToken, "voice.ogg");
        const text = await this.#config.stt.transcribe(path);
        if (!text.trim()) {
          await sendResponse(this.#bot, this.#config.authorizedChatId, "[Could not understand audio]");
          return;
        }
        await sendResponse(this.#bot, this.#config.authorizedChatId, `[Received audio]: ${text}`);
        this.#orchestrator.handleMessage(text);
      } catch (err) {
        log.error({ err }, "Voice transcription failed");
        await sendResponse(this.#bot, this.#config.authorizedChatId, "[Failed to transcribe audio]");
      }
    });

    this.#bot.on("callback_query:data", async (ctx) => {
      await ctx.answerCallbackQuery();
      const data = ctx.callbackQuery.data;
      if (data === "_noop") return;
      if (ctx.chat?.id.toString() !== this.#config.authorizedChatId) return;

      if (data === "_dismiss") {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        return;
      }

      if (data.startsWith("detail:")) {
        const sessionId = data.slice(7);
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: "✓ Opened", callback_data: "_noop" }]] } });
        log.debug({ sessionId }, "Detail requested");
        this.#orchestrator.handleDetail(sessionId);
        return;
      }

      if (data.startsWith("peek:")) {
        const sessionId = data.slice(5);
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: "✓ Peeked", callback_data: "_noop" }]] } });
        log.debug({ sessionId }, "Peek requested");
        this.#orchestrator.handlePeek(sessionId);
        return;
      }

      if (data.startsWith("kill:")) {
        const sessionId = data.slice(5);
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: "✓ Killed", callback_data: "_noop" }]] } });
        log.debug({ sessionId }, "Kill requested");
        this.#orchestrator.handleKill(sessionId);
        return;
      }

      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: `✓ ${data}`, callback_data: "_noop" }]] } });
      log.debug({ label: data }, "Button clicked");
      this.#orchestrator.handleButton(data);
    });

    this.#bot.on("message:text", (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) {
        log.debug({ chatId: ctx.chat.id }, "Unauthorized message");
        return;
      }

      this.#orchestrator.handleMessage(ctx.message.text);
    });

    this.#bot.catch((err) => {
      log.error({ err }, "Bot error");
    });
  }
}
