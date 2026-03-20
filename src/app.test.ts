import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { App, type AppConfig } from "./app";
import { type Claude, QueryProcessError, type QueryResult, type RunningQuery } from "./claude";
import { saveSessions } from "./sessions";
import type { SpeechToText } from "./speech-to-text";

const mockTranscribe = mock(async (_filePath: string) => "transcribed text");

function mockStt(): SpeechToText {
  return { transcribe: mockTranscribe } as unknown as SpeechToText;
}

// Mock Grammy Bot
mock.module("grammy", () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Function>();
    filterHandlers = new Map<string, Function[]>();
    errorHandler: Function | null = null;

    api = {
      sendMessage: mock(async () => {}),
      sendChatAction: mock(async () => {}),
      setMyCommands: mock(async () => {}),
      getFile: mock(async () => ({ file_path: "photos/test.jpg" })),
      sendPhoto: mock(async () => {}),
      sendDocument: mock(async () => {}),
    };

    constructor(token: string) {
      this.token = token;
    }

    command(name: string, handler: Function) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Function) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Function) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (info: any) => void }) {
      opts.onStart({ username: "test_bot", id: 123 });
    }
  },
}));

const tmpSettingsDir = "/tmp/macroclaw-test-settings";

beforeEach(() => {
  mockTranscribe.mockReset();
  mockTranscribe.mockImplementation(async () => "transcribed text");
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
  saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
});

afterEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

function queryResult<T>(value: T, sessionId = "test-session-id"): QueryResult<T> {
  return { value, sessionId, duration: "1.0s", cost: "$0.05" };
}

function resolvedQuery<T>(value: T, sessionId = "test-session-id"): RunningQuery<T> {
  return {
    sessionId,
    startedAt: new Date(),
    result: Promise.resolve(queryResult(value, sessionId)),
    kill: mock(async () => {}),
  };
}

interface CallInfo {
  method: string;
  prompt: string;
  sessionId?: string;
}

function mockClaude(handler: (info: CallInfo) => RunningQuery<unknown>): Claude & { calls: CallInfo[] } {
  const calls: CallInfo[] = [];
  const claude = {
    newSession: mock((prompt: string, _resultType: unknown, _options?: any) => {
      const info: CallInfo = { method: "newSession", prompt };
      calls.push(info);
      return handler(info);
    }),
    resumeSession: mock((sessionId: string, prompt: string, _resultType: unknown, _options?: any) => {
      const info: CallInfo = { method: "resumeSession", sessionId, prompt };
      calls.push(info);
      return handler(info);
    }),
    forkSession: mock((sessionId: string, prompt: string, _resultType: unknown, _options?: any) => {
      const info: CallInfo = { method: "forkSession", sessionId, prompt };
      calls.push(info);
      return handler(info);
    }),
    calls,
  } as unknown as Claude & { calls: CallInfo[] };
  return claude;
}

function defaultMockClaude(): Claude & { calls: CallInfo[] } {
  return mockClaude((info) =>
    resolvedQuery({ action: "send", message: `Response to: ${info.prompt}`, actionReason: "user message" }),
  );
}

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    botToken: "test-token",
    authorizedChatId: "12345",
    workspace: "/tmp/macroclaw-test-workspace",
    settingsDir: tmpSettingsDir,
    claude: defaultMockClaude(),
    stt: mockStt(),
    ...overrides,
  };
}

describe("App", () => {
  it("creates bot", () => {
    const app = new App(makeConfig());
    expect(app.bot).toBeDefined();
  });

  it("registers message:text, message:photo, message:document, message:voice, and callback_query:data handlers", () => {
    const app = new App(makeConfig());
    const bot = app.bot as any;
    expect(bot.filterHandlers.has("message:text")).toBe(true);
    expect(bot.filterHandlers.has("message:photo")).toBe(true);
    expect(bot.filterHandlers.has("message:document")).toBe(true);
    expect(bot.filterHandlers.has("message:voice")).toBe(true);
    expect(bot.filterHandlers.has("callback_query:data")).toBe(true);
  });

  it("registers chatid, bg, and sessions commands", () => {
    const app = new App(makeConfig());
    const bot = app.bot as any;
    expect(bot.commandHandlers.has("chatid")).toBe(true);
    expect(bot.commandHandlers.has("bg")).toBe(true);
    expect(bot.commandHandlers.has("sessions")).toBe(true);
  });

  it("registers error handler", () => {
    const app = new App(makeConfig());
    const bot = app.bot as any;
    expect(bot.errorHandler).not.toBeNull();
  });

  describe("message handler", () => {
    it("routes messages from authorized chat to orchestrator", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const claude = config.claude as Claude & { calls: CallInfo[] };
      expect(claude.calls[0].prompt).toBe("hello");
    });

    it("ignores messages from unauthorized chats", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 99999 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect((config.claude as Claude & { calls: CallInfo[] }).calls).toHaveLength(0);
    });

    it("sends [No output] for empty claude response", async () => {
      const claude = mockClaude(() => resolvedQuery({ action: "send", message: "", actionReason: "empty" }));
      const config = makeConfig({ claude });
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const lastText = calls[calls.length - 1][1];
      expect(lastText).toBe("[No output]");
    });

    it("skips sending when action is silent", async () => {
      const claude = mockClaude(() => resolvedQuery({ action: "silent", actionReason: "no new results" }));
      const config = makeConfig({ claude });
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it("does not treat bg: prefix as special", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "bg: research pricing" } });
      await new Promise((r) => setTimeout(r, 50));

      const claude = config.claude as Claude & { calls: CallInfo[] };
      expect(claude.calls[0].prompt).toBe("bg: research pricing");
    });

    it("sends error wrapped in response", async () => {
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "err-sid",
        startedAt: new Date(),
        result: Promise.reject(new QueryProcessError(1, "spawn failed")),
        kill: mock(async () => {}),
      }));
      const config = makeConfig({ claude });
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const lastText = calls[calls.length - 1][1];
      expect(lastText).toContain("[Error]");
      expect(lastText).toContain("spawn failed");
    });

    it("handles photo messages by downloading and routing with files", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-image", { status: 200 })),
      ) as any;

      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:photo")![0];

      await handler({
        chat: { id: 12345 },
        message: {
          caption: "check this",
          photo: [
            { file_id: "small", width: 90, height: 90 },
            { file_id: "large", width: 800, height: 600 },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.getFile).toHaveBeenCalledWith("large");
      const claude = config.claude as Claude & { calls: CallInfo[] };
      expect(claude.calls).toHaveLength(1);
      expect(claude.calls[0].prompt).toContain("[File:");

      globalThis.fetch = origFetch;
    });

    it("handles document messages by downloading and routing with files", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-doc", { status: 200 })),
      ) as any;

      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:document")![0];

      await handler({
        chat: { id: 12345 },
        message: {
          caption: "review this",
          document: { file_id: "doc-id", file_name: "report.pdf" },
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.getFile).toHaveBeenCalledWith("doc-id");
      const claude = config.claude as Claude & { calls: CallInfo[] };
      expect(claude.calls).toHaveLength(1);
      expect(claude.calls[0].prompt).toContain("[File:");

      globalThis.fetch = origFetch;
    });

    it("routes error message when photo download fails", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      bot.api.getFile = mock(async () => { throw new Error("too large"); });
      const handler = bot.filterHandlers.get("message:photo")![0];

      await handler({
        chat: { id: 12345 },
        message: { caption: "big photo", photo: [{ file_id: "big" }] },
      });
      await new Promise((r) => setTimeout(r, 50));

      const claude = config.claude as Claude & { calls: CallInfo[] };
      expect(claude.calls).toHaveLength(1);
      expect(claude.calls[0].prompt).toContain("[File download failed: photo.jpg]");
    });

    it("routes error message when document download fails", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      bot.api.getFile = mock(async () => { throw new Error("too large"); });
      const handler = bot.filterHandlers.get("message:document")![0];

      await handler({
        chat: { id: 12345 },
        message: { caption: "big doc", document: { file_id: "big", file_name: "huge.pdf" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const claude = config.claude as Claude & { calls: CallInfo[] };
      expect(claude.calls).toHaveLength(1);
      expect(claude.calls[0].prompt).toContain("[File download failed: huge.pdf]");
    });

    it("handles voice messages by transcribing and routing text to orchestrator", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-audio", { status: 200 })),
      ) as any;
      mockTranscribe.mockImplementationOnce(async () => "hello from voice");

      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:voice")![0];

      await handler({
        chat: { id: 12345 },
        message: { voice: { file_id: "voice-id", duration: 5 } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const echoCall = sendCalls.find((c: any) => c[1].includes("[Received audio]"));
      expect(echoCall).toBeDefined();
      expect(echoCall[1]).toContain("hello from voice");

      const claude = config.claude as Claude & { calls: CallInfo[] };
      expect(claude.calls).toHaveLength(1);
      expect(claude.calls[0].prompt).toBe("hello from voice");

      globalThis.fetch = origFetch;
    });

    it("sends error message when voice transcription fails", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-audio", { status: 200 })),
      ) as any;
      mockTranscribe.mockImplementationOnce(async () => { throw new Error("API error"); });

      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:voice")![0];

      await handler({
        chat: { id: 12345 },
        message: { voice: { file_id: "voice-id", duration: 5 } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const errorCall = sendCalls.find((c: any) => c[1].includes("[Failed to transcribe audio]"));
      expect(errorCall).toBeDefined();
      expect((config.claude as Claude & { calls: CallInfo[] }).calls).toHaveLength(0);

      globalThis.fetch = origFetch;
    });

    it("sends message when voice transcription returns empty text", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-audio", { status: 200 })),
      ) as any;
      mockTranscribe.mockImplementationOnce(async () => "  ");

      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:voice")![0];

      await handler({
        chat: { id: 12345 },
        message: { voice: { file_id: "voice-id", duration: 2 } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const emptyCall = sendCalls.find((c: any) => c[1].includes("[Could not understand audio]"));
      expect(emptyCall).toBeDefined();
      expect((config.claude as Claude & { calls: CallInfo[] }).calls).toHaveLength(0);

      globalThis.fetch = origFetch;
    });

    it("ignores voice messages from unauthorized chats", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:voice")![0];

      await handler({
        chat: { id: 99999 },
        message: { voice: { file_id: "voice-id", duration: 5 } },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect((config.claude as Claude & { calls: CallInfo[] }).calls).toHaveLength(0);
    });

    it("responds with unavailable message when stt is not configured", async () => {
      const config = makeConfig({ stt: undefined });
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:voice")![0];

      await handler({
        chat: { id: 12345 },
        message: { voice: { file_id: "voice-id", duration: 5 } },
      });

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const call = sendCalls.find((c: any) => c[1].includes("openaiApiKey"));
      expect(call).toBeDefined();
      expect((config.claude as Claude & { calls: CallInfo[] }).calls).toHaveLength(0);
    });

    it("ignores photo messages from unauthorized chats", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:photo")![0];

      await handler({
        chat: { id: 99999 },
        message: { photo: [{ file_id: "x" }] },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect((config.claude as Claude & { calls: CallInfo[] }).calls).toHaveLength(0);
    });

    it("sends outbound files before text message (onResponse delivery)", async () => {
      const tmpFile = `/tmp/macroclaw-test-outbound-${Date.now()}.png`;
      await Bun.write(tmpFile, "fake png");

      const claude = mockClaude(() => resolvedQuery({
        action: "send",
        message: "Here's your chart",
        actionReason: "ok",
        files: [tmpFile],
      }));
      const config = makeConfig({ claude });
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "make a chart" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1);
      expect(bot.api.sendMessage).toHaveBeenCalled();

      const { rm } = await import("node:fs/promises");
      await rm(tmpFile, { force: true });
    });

    it("passes buttons to sendResponse (onResponse delivery)", async () => {
      const claude = mockClaude(() => resolvedQuery({
        action: "send",
        message: "Choose one",
        actionReason: "ok",
        buttons: ["Yes", "No"],
      }));
      const config = makeConfig({ claude });
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[2].reply_markup).toBeDefined();
    });

    it("handles callback_query by routing button event to orchestrator", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("callback_query:data")![0];

      const ctx = {
        chat: { id: 12345 },
        callbackQuery: { data: "Yes", message: { text: "Choose one" } },
        answerCallbackQuery: mock(async () => {}),
        editMessageReplyMarkup: mock(async () => {}),
      };

      await handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [[{ text: "✓ Yes", callback_data: "_noop" }]] } });
      const claude = config.claude as Claude & { calls: CallInfo[] };
      expect(claude.calls).toHaveLength(1);
      expect(claude.calls[0].prompt).toBe('[Context: button-click] User tapped "Yes"');
    });

    it("handles _dismiss callback by removing reply markup", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("callback_query:data")![0];

      const ctx = {
        chat: { id: 12345 },
        callbackQuery: { data: "_dismiss" },
        answerCallbackQuery: mock(async () => {}),
        editMessageReplyMarkup: mock(async () => {}),
      };

      await handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: undefined });
      expect((config.claude as Claude & { calls: CallInfo[] }).calls).toHaveLength(0);
    });

    it("handles detail: callback by routing to orchestrator.handleDetail", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("callback_query:data")![0];

      const ctx = {
        chat: { id: 12345 },
        callbackQuery: { data: "detail:test-session-123" },
        answerCallbackQuery: mock(async () => {}),
        editMessageReplyMarkup: mock(async () => {}),
      };

      await handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [[{ text: "✓ Opened", callback_data: "_noop" }]] } });
      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toBe("Session not found or already finished.");
    });

    it("handles peek: callback by routing to orchestrator.handlePeek", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("callback_query:data")![0];

      const ctx = {
        chat: { id: 12345 },
        callbackQuery: { data: "peek:test-session-123" },
        answerCallbackQuery: mock(async () => {}),
        editMessageReplyMarkup: mock(async () => {}),
      };

      await handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [[{ text: "✓ Peeked", callback_data: "_noop" }]] } });
      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toBe("Session not found or already finished.");
    });

    it("handles kill: callback by routing to orchestrator.handleKill", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("callback_query:data")![0];

      const ctx = {
        chat: { id: 12345 },
        callbackQuery: { data: "kill:test-session-123" },
        answerCallbackQuery: mock(async () => {}),
        editMessageReplyMarkup: mock(async () => {}),
      };

      await handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [[{ text: "✓ Killed", callback_data: "_noop" }]] } });
      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toBe("Session not found or already finished.");
    });

    it("ignores callback_query from unauthorized chats", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("callback_query:data")![0];

      const ctx = {
        chat: { id: 99999 },
        callbackQuery: { data: "Yes", message: { text: "Choose" } },
        answerCallbackQuery: mock(async () => {}),
        editMessageReplyMarkup: mock(async () => {}),
      };

      await handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect((config.claude as Claude & { calls: CallInfo[] }).calls).toHaveLength(0);
    });

    it("skips outbound files that don't exist", async () => {
      const claude = mockClaude(() => resolvedQuery({
        action: "send",
        message: "Done",
        actionReason: "ok",
        files: ["/tmp/nonexistent-xyz.png"],
      }));
      const config = makeConfig({ claude });
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.sendPhoto).not.toHaveBeenCalled();
      expect(bot.api.sendMessage).toHaveBeenCalled();
    });
  });

  describe("commands", () => {
    it("/chatid replies with chat ID", () => {
      const app = new App(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("chatid")!;
      const ctx = { chat: { id: 12345 }, reply: mock(() => {}) };

      handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith("Chat ID: `12345`", { parse_mode: "Markdown" });
    });

    it("/bg without prompt sends usage hint", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("bg")!;
      const ctx = { chat: { id: 12345 }, match: "" };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect((config.claude as Claude & { calls: CallInfo[] }).calls).toHaveLength(0);
      const calls = (bot.api.sendMessage as any).mock.calls;
      expect(calls[calls.length - 1][1]).toBe("Usage: /bg <prompt>");
    });

    it("/bg with prompt spawns a background agent via sendMessage", async () => {
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "bg-sid",
        startedAt: new Date(),
        result: new Promise(() => {}),
        kill: mock(async () => {}),
      }));
      const config = makeConfig({ claude });
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("bg")!;
      const ctx = { chat: { id: 12345 }, match: "research pricing" };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toBe('Background agent "research-pricing" started.');
      expect(claude.calls).toHaveLength(1);
    });

    it("/sessions lists running sessions via sendMessage", async () => {
      const app = new App(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("sessions")!;
      const ctx = { chat: { id: 12345 } };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toBe("No running sessions.");
    });

    it("/sessions is ignored for unauthorized chats", async () => {
      const app = new App(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("sessions")!;
      const ctx = { chat: { id: 99999 } };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      // No sendMessage calls for unauthorized
      expect((bot.api.sendMessage as any).mock.calls.length).toBe(0);
    });


  });

  describe("error handler", () => {
    it("does not throw on bot errors", () => {
      const app = new App(makeConfig());
      const bot = app.bot as any;

      expect(() => bot.errorHandler({ message: "connection lost" })).not.toThrow();
    });
  });

  describe("start", () => {
    it("starts the bot and logs info", () => {
      const app = new App(makeConfig());
      expect(() => app.start()).not.toThrow();
    });

    it("registers commands with Telegram on start", () => {
      const app = new App(makeConfig());
      const bot = app.bot as any;

      app.start();
      expect(bot.api.setMyCommands).toHaveBeenCalledWith([
        { command: "chatid", description: "Show current chat ID" },
        { command: "bg", description: "Spawn a background agent" },
        { command: "sessions", description: "List running sessions" },
      ]);
    });
  });
});
