import type { Bot } from "grammy";
import type { Claude } from "./claude";
import { CronScheduler } from "./cron";
import { createLogger } from "./logger";
import { Orchestrator, type OrchestratorResponse } from "./orchestrator";
import { transcribe } from "./stt";
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
      onResponse: (r) => this.#deliverResponse(r),
    });

    this.#setupHandlers();
  }

  get bot() {
    return this.#bot;
  }

  start() {
    log.info("Starting macroclaw...");
    const cron = new CronScheduler(this.#config.workspace, {
      onJob: (name, prompt, model) => this.#orchestrator.handleCron(name, prompt, model),
    });
    cron.start();
    this.#bot.api.setMyCommands([
      { command: "chatid", description: "Show current chat ID" },
      { command: "session", description: "Show current session ID" },
      { command: "bg", description: "List or spawn background agents" },
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

    this.#bot.command("session", (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      log.debug("Command /session");
      this.#orchestrator.handleSessionCommand();
    });

    this.#bot.command("bg", (ctx) => {
      if (ctx.chat.id.toString() !== this.#config.authorizedChatId) return;
      const prompt = ctx.match?.trim();
      if (prompt) {
        log.debug({ prompt }, "Command /bg spawn");
        this.#orchestrator.handleBackgroundCommand(prompt);
        return;
      }
      log.debug("Command /bg list");
      this.#orchestrator.handleBackgroundList();
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
      try {
        const path = await downloadFile(this.#bot, ctx.message.voice.file_id, this.#config.botToken, "voice.ogg");
        const text = await transcribe(path);
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
      const label = ctx.callbackQuery.data;
      if (label === "_noop") return;
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: `✓ ${label}`, callback_data: "_noop" }]] } });
      if (ctx.chat?.id.toString() !== this.#config.authorizedChatId) return;
      log.debug({ label }, "Button clicked");
      this.#orchestrator.handleButton(label);
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
