import type { Bot } from "grammy";
import { AuthorizedChats, DuplicateChatError, InvalidChatNameError, UnknownChatError } from "./authorized-chats";
import { createLogger } from "./logger";
import { type Claude, Orchestrator, type OrchestratorResponse } from "./orchestrator";
import { Scheduler } from "./scheduler";
import { clearMainSession } from "./sessions";
import type { SpeechToText } from "./speech-to-text";
import { createBot, downloadFile, sendFile, sendResponse } from "./telegram";

const log = createLogger("app");

const ADMIN_CHAT_NAME = "admin";

export interface AppConfig {
  botToken: string;
  adminChatId: string;
  workspace: string;
  model: string;
  timeZone: string;
  settingsDir?: string;
  claude?: Claude;
  stt?: SpeechToText;
  healthCheckInterval?: number;
  /** Injected for tests. If omitted, a fresh AuthorizedChats is constructed from settingsDir. */
  authorizedChats?: AuthorizedChats;
}

export class App {
  #bot: Bot;
  #config: AppConfig;
  #authorizedChats: AuthorizedChats;
  #orchestrators = new Map<string, Orchestrator>();

  constructor(config: AppConfig) {
    this.#config = config;
    this.#bot = createBot(config.botToken);
    this.#authorizedChats = config.authorizedChats ?? new AuthorizedChats(config.settingsDir);

    this.#createOrchestrator(ADMIN_CHAT_NAME, config.adminChatId);
    for (const chat of this.#authorizedChats.list()) {
      this.#createOrchestrator(chat.name, chat.chatId);
    }

    this.#setupHandlers();
  }

  get bot() {
    return this.#bot;
  }

  async dispose(): Promise<void> {
    for (const orch of this.#orchestrators.values()) {
      await orch.dispose();
    }
    this.#orchestrators.clear();
  }

  start() {
    log.info("Starting macroclaw...");
    const adminOrch = this.#adminOrchestrator();
    const scheduler = new Scheduler(this.#config.workspace, {
      timeZone: this.#config.timeZone,
      onJob: (name, prompt, model, missed) => adminOrch.handleCron(name, prompt, model, missed),
    });
    scheduler.start();
    this.#bot.api.setMyCommands([
      { command: "chatid", description: "Show current chat ID" },
      { command: "bg", description: "Spawn a background agent" },
      { command: "sessions", description: "List running sessions" },
      { command: "clear", description: "Clear session and start fresh" },
      { command: "chats", description: "List authorized chats (admin only)" },
      { command: "chats_add", description: "Authorize a new chat (admin only)" },
      { command: "chats_remove", description: "Remove an authorized chat (admin only)" },
    ]).catch((err) => log.error({ err }, "Failed to set commands"));
    this.#bot.start({
      onStart: (botInfo) => {
        log.info(
          { username: botInfo.username, adminChatId: this.#config.adminChatId, authorizedChats: this.#authorizedChats.list().length },
          "Bot connected",
        );
      },
    });
  }

  #createOrchestrator(chatName: string, chatId: string): Orchestrator {
    const orch = new Orchestrator({
      chatName,
      model: this.#config.model,
      workspace: this.#config.workspace,
      timeZone: this.#config.timeZone,
      settingsDir: this.#config.settingsDir,
      claude: this.#config.claude,
      healthCheckInterval: this.#config.healthCheckInterval,
      onResponse: (r) => this.#deliverResponse(chatId, r),
    });
    this.#orchestrators.set(chatId, orch);
    return orch;
  }

  #isAdminChat(chatId: number | string): boolean {
    return chatId.toString() === this.#config.adminChatId;
  }

  #adminOrchestrator(): Orchestrator {
    const orch = this.#orchestrators.get(this.#config.adminChatId);
    if (!orch) throw new Error("Admin orchestrator missing — this should be impossible");
    return orch;
  }

  #resolveOrchestrator(chatId: number | string): Orchestrator | undefined {
    return this.#orchestrators.get(chatId.toString());
  }

  async #deliverResponse(chatId: string, response: OrchestratorResponse) {
    if (response.files?.length) {
      for (const filePath of response.files) {
        await sendFile(this.#bot, chatId, filePath);
      }
    }
    await sendResponse(this.#bot, chatId, response.message, response.buttons);
  }

  #setupHandlers() {
    this.#bot.command("chatid", (ctx) => {
      log.debug("Command /chatid");
      ctx.reply(`Chat ID: \`${ctx.chat.id}\``, { parse_mode: "Markdown" });
    });

    this.#bot.command("bg", (ctx) => {
      const orch = this.#resolveOrchestrator(ctx.chat.id);
      if (!orch) return;
      const prompt = ctx.match?.trim();
      if (!prompt) {
        log.debug("Command /bg without prompt");
        sendResponse(this.#bot, ctx.chat.id.toString(), "Usage: /bg &lt;prompt&gt;");
        return;
      }
      log.debug({ prompt }, "Command /bg spawn");
      orch.handleBackgroundCommand(prompt);
    });

    this.#bot.command("sessions", (ctx) => {
      const orch = this.#resolveOrchestrator(ctx.chat.id);
      if (!orch) return;
      log.debug("Command /sessions");
      orch.handleSessions();
    });

    this.#bot.command("clear", (ctx) => {
      const orch = this.#resolveOrchestrator(ctx.chat.id);
      if (!orch) return;
      log.debug("Command /clear");
      orch.handleClear();
    });

    this.#bot.command("chats", (ctx) => {
      if (!this.#isAdminChat(ctx.chat.id)) return;
      log.debug("Command /chats");
      const chatIdStr = ctx.chat.id.toString();
      const chats = this.#authorizedChats.list();
      if (chats.length === 0) {
        sendResponse(this.#bot, chatIdStr, "No authorized chats.");
        return;
      }
      const lines = chats.map((c) => `- ${c.name} (${c.chatId})`).join("\n");
      sendResponse(this.#bot, chatIdStr, `Authorized chats:\n${lines}`);
    });

    this.#bot.command("chats-add", (ctx) => {
      if (!this.#isAdminChat(ctx.chat.id)) return;
      log.debug("Command /chats-add");
      const chatIdStr = ctx.chat.id.toString();
      const args = ctx.match?.trim().split(/\s+/);
      if (!args || args.length < 2 || !args[0] || !args[1]) {
        sendResponse(this.#bot, chatIdStr, "Usage: /chats-add &lt;chatId&gt; &lt;name&gt;");
        return;
      }
      const [newChatId, name] = args;
      try {
        const chat = this.#authorizedChats.add(newChatId, name);
        this.#createOrchestrator(chat.name, chat.chatId);
        log.info({ chatId: chat.chatId, name: chat.name }, "Authorized chat added");
        sendResponse(this.#bot, chatIdStr, `Chat "${chat.name}" (${chat.chatId}) authorized.`);
      } catch (err) {
        if (err instanceof DuplicateChatError || err instanceof InvalidChatNameError) {
          sendResponse(this.#bot, chatIdStr, `Error: ${err.message}`);
        } else {
          throw err;
        }
      }
    });

    this.#bot.command("chats-remove", async (ctx) => {
      if (!this.#isAdminChat(ctx.chat.id)) return;
      log.debug("Command /chats-remove");
      const chatIdStr = ctx.chat.id.toString();
      const name = ctx.match?.trim();
      if (!name) {
        sendResponse(this.#bot, chatIdStr, "Usage: /chats-remove &lt;name&gt;");
        return;
      }
      try {
        const chat = this.#authorizedChats.remove(name);
        const orch = this.#orchestrators.get(chat.chatId);
        if (orch) {
          await orch.dispose();
          this.#orchestrators.delete(chat.chatId);
        }
        clearMainSession(name, this.#config.settingsDir);
        log.info({ chatId: chat.chatId, name }, "Authorized chat removed");
        sendResponse(this.#bot, chatIdStr, `Chat "${name}" removed.`);
      } catch (err) {
        if (err instanceof UnknownChatError) {
          sendResponse(this.#bot, chatIdStr, `Error: ${err.message}`);
        } else {
          throw err;
        }
      }
    });

    this.#bot.on("message:photo", async (ctx) => {
      const orch = this.#resolveOrchestrator(ctx.chat.id);
      if (!orch) return;
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      try {
        const path = await downloadFile(this.#bot, largest.file_id, this.#config.botToken, "photo.jpg");
        orch.handleMessage(ctx.message.caption ?? "", [path]);
      } catch (err) {
        log.error({ err }, "Photo download failed");
        orch.handleMessage(`[File download failed: photo.jpg]\n${ctx.message.caption ?? ""}`);
      }
    });

    this.#bot.on("message:document", async (ctx) => {
      const orch = this.#resolveOrchestrator(ctx.chat.id);
      if (!orch) return;
      const doc = ctx.message.document;
      const name = doc.file_name ?? "file";
      try {
        const path = await downloadFile(this.#bot, doc.file_id, this.#config.botToken, name);
        orch.handleMessage(ctx.message.caption ?? "", [path]);
      } catch (err) {
        log.error({ err }, "Document download failed");
        orch.handleMessage(`[File download failed: ${name}]\n${ctx.message.caption ?? ""}`);
      }
    });

    this.#bot.on("message:voice", async (ctx) => {
      const orch = this.#resolveOrchestrator(ctx.chat.id);
      if (!orch) return;
      const chatIdStr = ctx.chat.id.toString();
      if (!this.#config.stt) {
        await sendResponse(this.#bot, chatIdStr, "[Voice messages not available — set openaiApiKey in settings to enable]");
        return;
      }
      try {
        const path = await downloadFile(this.#bot, ctx.message.voice.file_id, this.#config.botToken, "voice.ogg");
        const text = await this.#config.stt.transcribe(path);
        if (!text.trim()) {
          await sendResponse(this.#bot, chatIdStr, "[Could not understand audio]");
          return;
        }
        await sendResponse(this.#bot, chatIdStr, `[Received audio]: ${text}`);
        orch.handleMessage(text);
      } catch (err) {
        log.error({ err }, "Voice transcription failed");
        await sendResponse(this.#bot, chatIdStr, "[Failed to transcribe audio]");
      }
    });

    this.#bot.on("callback_query:data", async (ctx) => {
      await ctx.answerCallbackQuery();
      const data = ctx.callbackQuery.data;
      if (data === "_noop") return;

      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      const orch = this.#resolveOrchestrator(chatId);
      if (!orch) return;

      if (data === "_dismiss") {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        return;
      }

      if (data.startsWith("detail:")) {
        const sessionId = data.slice(7);
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: "✓ Opened", callback_data: "_noop" }]] } });
        log.debug({ sessionId }, "Detail requested");
        orch.handleDetail(sessionId);
        return;
      }

      if (data.startsWith("peek:")) {
        const sessionId = data.slice(5);
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: "✓ Peeked", callback_data: "_noop" }]] } });
        log.debug({ sessionId }, "Peek requested");
        orch.handlePeek(sessionId);
        return;
      }

      if (data.startsWith("kill:")) {
        const sessionId = data.slice(5);
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: "✓ Killed", callback_data: "_noop" }]] } });
        log.debug({ sessionId }, "Kill requested");
        orch.handleKill(sessionId);
        return;
      }

      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: `✓ ${data}`, callback_data: "_noop" }]] } });
      log.debug({ label: data }, "Button clicked");
      orch.handleButton(data);
    });

    this.#bot.on("message:text", (ctx) => {
      const orch = this.#resolveOrchestrator(ctx.chat.id);
      if (!orch) {
        log.debug({ chatId: ctx.chat.id }, "Unauthorized message");
        return;
      }

      orch.handleMessage(ctx.message.text);
    });

    this.#bot.catch((err) => {
      log.error({ err }, "Bot error");
    });
  }
}
