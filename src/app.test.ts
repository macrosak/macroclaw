import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { App, type AppConfig } from "./app";
import { AuthorizedChats } from "./authorized-chats";
import { type Claude, type ClaudeProcess, type ProcessState, QueryProcessError, type QueryResult } from "./claude";
import { loadSessions, saveSessions } from "./sessions";
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
  InlineKeyboard: class MockInlineKeyboard {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [[]];
    text(label: string, data: string) {
      this.inline_keyboard[this.inline_keyboard.length - 1].push({ text: label, callback_data: data });
      return this;
    }
    row() {
      this.inline_keyboard.push([]);
      return this;
    }
  },
  InputFile: class MockInputFile {
    constructor(public path: string) {}
  },
}));

const tmpSettingsDir = "/tmp/macroclaw-test-settings";
const activeApps: App[] = [];

beforeEach(() => {
  mockTranscribe.mockReset();
  mockTranscribe.mockImplementation(async () => "transcribed text");
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
  saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
});

afterEach(async () => {
  for (const app of activeApps.splice(0)) {
    await app.dispose();
  }
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

function queryResult<T>(value: T, sessionId = "test-session-id"): QueryResult<T> {
  return { value, sessionId, duration: "1.0s", cost: "$0.05" };
}

function autoProcess(value: unknown, sessionId = "test-sid"): ClaudeProcess<unknown> {
  return {
    sessionId,
    startedAt: new Date(),
    get state(): ProcessState { return "idle"; },
    send: mock(async (_prompt: string) => queryResult(value, sessionId)),
    kill: mock(async () => {}),
  } as unknown as ClaudeProcess<unknown>;
}

interface CallInfo {
  method: string;
  sessionId?: string;
}

function mockClaude(handler: (info: CallInfo) => ClaudeProcess<unknown>): Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] } {
  const calls: CallInfo[] = [];
  const processes: ClaudeProcess<unknown>[] = [];

  function handleCall(info: CallInfo): ClaudeProcess<unknown> {
    calls.push(info);
    const proc = handler(info);
    processes.push(proc);
    return proc;
  }

  const claude = {
    newSession: mock((_resultType: unknown, _options?: unknown) => {
      return handleCall({ method: "newSession" });
    }),
    resumeSession: mock((sessionId: string, _resultType: unknown, _options?: unknown) => {
      return handleCall({ method: "resumeSession", sessionId });
    }),
    forkSession: mock((sessionId: string, _resultType: unknown, _options?: unknown) => {
      return handleCall({ method: "forkSession", sessionId });
    }),
    calls,
    processes,
  } as unknown as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
  return claude;
}

function defaultMockClaude(): Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] } {
  return mockClaude(() =>
    autoProcess({ action: "send", message: "Response", actionReason: "user message" }),
  );
}

function sentPrompts(claude: { processes: ClaudeProcess<unknown>[] }): string[] {
  return claude.processes.flatMap((p) =>
    (p.send as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0] as string),
  );
}

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    botToken: "test-token",
    adminChatId: "12345",
    workspace: "/tmp/macroclaw-test-workspace",
    model: "sonnet",
    timeZone: "UTC",
    settingsDir: tmpSettingsDir,
    claude: defaultMockClaude(),
    stt: mockStt(),
    healthCheckInterval: 0,
    ...overrides,
  };
}

function makeApp(overrides?: Partial<AppConfig>): App {
  const app = new App(makeConfig(overrides));
  activeApps.push(app);
  return app;
}

function trackApp(app: App): App {
  activeApps.push(app);
  return app;
}

describe("App", () => {
  it("creates bot", () => {
    const app = makeApp();
    expect(app.bot).toBeDefined();
  });

  it("registers message:text, message:photo, message:document, message:voice, and callback_query:data handlers", () => {
    const app = makeApp();
    const bot = app.bot as any;
    expect(bot.filterHandlers.has("message:text")).toBe(true);
    expect(bot.filterHandlers.has("message:photo")).toBe(true);
    expect(bot.filterHandlers.has("message:document")).toBe(true);
    expect(bot.filterHandlers.has("message:voice")).toBe(true);
    expect(bot.filterHandlers.has("callback_query:data")).toBe(true);
  });

  it("registers chatid, bg, sessions, clear, and chats commands", () => {
    const app = makeApp();
    const bot = app.bot as any;
    expect(bot.commandHandlers.has("chatid")).toBe(true);
    expect(bot.commandHandlers.has("bg")).toBe(true);
    expect(bot.commandHandlers.has("sessions")).toBe(true);
    expect(bot.commandHandlers.has("clear")).toBe(true);
    expect(bot.commandHandlers.has("chats")).toBe(true);
    expect(bot.commandHandlers.has("chatsadd")).toBe(true);
    expect(bot.commandHandlers.has("chatsremove")).toBe(true);
  });

  it("registers error handler", () => {
    const app = makeApp();
    const bot = app.bot as any;
    expect(bot.errorHandler).not.toBeNull();
  });

  describe("message handler", () => {
    it("routes messages from authorized chat to orchestrator", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const claude = config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
      expect(sentPrompts(claude)[0]).toContain("<text>hello</text>");
    });

    it("ignores messages from unauthorized chats", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 99999 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect((config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] }).calls).toHaveLength(0);
    });

    it("sends [No output] for empty claude response", async () => {
      const claude = mockClaude(() => autoProcess({ action: "send", message: "", actionReason: "empty" }));
      const config = makeConfig({ claude });
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const lastText = calls[calls.length - 1][1];
      expect(lastText).toBe("[No output]");
    });

    it("skips sending when action is silent", async () => {
      const claude = mockClaude(() => autoProcess({ action: "silent", actionReason: "no new results" }));
      const config = makeConfig({ claude });
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it("does not treat bg: prefix as special", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "bg: research pricing" } });
      await new Promise((r) => setTimeout(r, 50));

      const claude = config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
      expect(sentPrompts(claude)[0]).toContain("<text>bg: research pricing</text>");
    });

    it("sends error wrapped in response", async () => {
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        const proc = autoProcess(null, "err-sid");
        (proc as any).send = mock(async () => { throw new QueryProcessError(1, "spawn failed"); });
        return proc;
      });
      const config = makeConfig({ claude });
      const app = trackApp(new App(config));
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
      const app = trackApp(new App(config));
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
      const claude = config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
      expect(claude.calls).toHaveLength(1);
      expect(sentPrompts(claude)[0]).toContain("<file path=");

      globalThis.fetch = origFetch;
    });

    it("handles document messages by downloading and routing with files", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-doc", { status: 200 })),
      ) as any;

      const config = makeConfig();
      const app = trackApp(new App(config));
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
      const claude = config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
      expect(claude.calls).toHaveLength(1);
      expect(sentPrompts(claude)[0]).toContain("<file path=");

      globalThis.fetch = origFetch;
    });

    it("routes error message when photo download fails", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      bot.api.getFile = mock(async () => { throw new Error("too large"); });
      const handler = bot.filterHandlers.get("message:photo")![0];

      await handler({
        chat: { id: 12345 },
        message: { caption: "big photo", photo: [{ file_id: "big" }] },
      });
      await new Promise((r) => setTimeout(r, 50));

      const claude = config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
      expect(claude.calls).toHaveLength(1);
      expect(sentPrompts(claude)[0]).toContain("[File download failed: photo.jpg]");
    });

    it("routes error message when document download fails", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      bot.api.getFile = mock(async () => { throw new Error("too large"); });
      const handler = bot.filterHandlers.get("message:document")![0];

      await handler({
        chat: { id: 12345 },
        message: { caption: "big doc", document: { file_id: "big", file_name: "huge.pdf" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const claude = config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
      expect(claude.calls).toHaveLength(1);
      expect(sentPrompts(claude)[0]).toContain("[File download failed: huge.pdf]");
    });

    it("handles voice messages by transcribing and routing text to orchestrator", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-audio", { status: 200 })),
      ) as any;
      mockTranscribe.mockImplementationOnce(async () => "hello from voice");

      const config = makeConfig();
      const app = trackApp(new App(config));
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

      const claude = config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
      expect(claude.calls).toHaveLength(1);
      expect(sentPrompts(claude)[0]).toContain("<text>hello from voice</text>");

      globalThis.fetch = origFetch;
    });

    it("sends error message when voice transcription fails", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-audio", { status: 200 })),
      ) as any;
      mockTranscribe.mockImplementationOnce(async () => { throw new Error("API error"); });

      const config = makeConfig();
      const app = trackApp(new App(config));
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
      expect((config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] }).calls).toHaveLength(0);

      globalThis.fetch = origFetch;
    });

    it("sends message when voice transcription returns empty text", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-audio", { status: 200 })),
      ) as any;
      mockTranscribe.mockImplementationOnce(async () => "  ");

      const config = makeConfig();
      const app = trackApp(new App(config));
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
      expect((config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] }).calls).toHaveLength(0);

      globalThis.fetch = origFetch;
    });

    it("ignores voice messages from unauthorized chats", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:voice")![0];

      await handler({
        chat: { id: 99999 },
        message: { voice: { file_id: "voice-id", duration: 5 } },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect((config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] }).calls).toHaveLength(0);
    });

    it("responds with unavailable message when stt is not configured", async () => {
      const config = makeConfig({ stt: undefined });
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:voice")![0];

      await handler({
        chat: { id: 12345 },
        message: { voice: { file_id: "voice-id", duration: 5 } },
      });

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const call = sendCalls.find((c: any) => c[1].includes("openaiApiKey"));
      expect(call).toBeDefined();
      expect((config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] }).calls).toHaveLength(0);
    });

    it("ignores photo messages from unauthorized chats", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:photo")![0];

      await handler({
        chat: { id: 99999 },
        message: { photo: [{ file_id: "x" }] },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect((config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] }).calls).toHaveLength(0);
    });

    it("sends outbound files before text message (onResponse delivery)", async () => {
      const tmpFile = `/tmp/macroclaw-test-outbound-${Date.now()}.png`;
      await Bun.write(tmpFile, "fake png");

      const claude = mockClaude(() => autoProcess({
        action: "send",
        message: "Here's your chart",
        actionReason: "ok",
        files: [tmpFile],
      }));
      const config = makeConfig({ claude });
      const app = trackApp(new App(config));
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
      const claude = mockClaude(() => autoProcess({
        action: "send",
        message: "Choose one",
        actionReason: "ok",
        buttons: ["Yes", "No"],
      }));
      const config = makeConfig({ claude });
      const app = trackApp(new App(config));
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
      const app = trackApp(new App(config));
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
      const claude = config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
      expect(claude.calls).toHaveLength(1);
      expect(sentPrompts(claude)[0]).toContain('<button>Yes</button>');
    });

    it("handles _dismiss callback by removing reply markup", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
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
      expect((config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] }).calls).toHaveLength(0);
    });

    it("handles detail: callback by routing to orchestrator.handleDetail", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
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
      const app = trackApp(new App(config));
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
      const app = trackApp(new App(config));
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
      const app = trackApp(new App(config));
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
      expect((config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] }).calls).toHaveLength(0);
    });

    it("skips outbound files that don't exist", async () => {
      const claude = mockClaude(() => autoProcess({
        action: "send",
        message: "Done",
        actionReason: "ok",
        files: ["/tmp/nonexistent-xyz.png"],
      }));
      const config = makeConfig({ claude });
      const app = trackApp(new App(config));
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
      const app = makeApp();
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("chatid")!;
      const ctx = { chat: { id: 12345 }, reply: mock(() => {}) };

      handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith("Chat ID: `12345`", { parse_mode: "Markdown" });
    });

    it("/bg without prompt sends usage hint", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("bg")!;
      const ctx = { chat: { id: 12345 }, match: "" };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect((config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] }).calls).toHaveLength(0);
      const calls = (bot.api.sendMessage as any).mock.calls;
      expect(calls[calls.length - 1][1]).toBe("Usage: /bg &lt;prompt&gt;");
    });

    it("/bg with prompt spawns a background agent via sendMessage", async () => {
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        return {
          sessionId: "bg-sid",
          startedAt: new Date(),
          get state(): ProcessState { return "busy"; },
          send: mock(async () => new Promise(() => {})),
          kill: mock(async () => {}),
        } as unknown as ClaudeProcess<unknown>;
      });
      const config = makeConfig({ claude });
      const app = trackApp(new App(config));
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
      const app = makeApp();
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("sessions")!;
      const ctx = { chat: { id: 12345 } };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toBe("No running sessions.");
    });

    it("/clear sends confirmation", async () => {
      const app = makeApp();
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("clear")!;
      const ctx = { chat: { id: 12345 } };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toBe("Session cleared.");
    });

    it("/clear is ignored for unauthorized chats", async () => {
      const app = makeApp();
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("clear")!;
      const ctx = { chat: { id: 99999 } };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect((bot.api.sendMessage as any).mock.calls.length).toBe(0);
    });

    it("/sessions is ignored for unauthorized chats", async () => {
      const app = makeApp();
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("sessions")!;
      const ctx = { chat: { id: 99999 } };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect((bot.api.sendMessage as any).mock.calls.length).toBe(0);
    });

    describe("/chats", () => {
      it("lists authorized chats for admin", async () => {
        const authorizedChats = new AuthorizedChats(tmpSettingsDir);
        authorizedChats.add("55555", "family");
        const app = makeApp({ authorizedChats });
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chats")!;

        handler({ chat: { id: 12345 } });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        const text = calls[calls.length - 1][1];
        expect(text).toContain("family");
        expect(text).toContain("55555");
      });

      it("reports no chats when list is empty", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chats")!;

        handler({ chat: { id: 12345 } });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toBe("No authorized chats.");
      });

      it("is ignored for non-admin chats", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chats")!;

        handler({ chat: { id: 99999 } });
        await new Promise((r) => setTimeout(r, 50));

        expect((bot.api.sendMessage as any).mock.calls.length).toBe(0);
      });
    });

    describe("/chatsadd", () => {
      it("adds chat and creates orchestrator for it", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsadd")!;

        handler({ chat: { id: 12345 }, match: "55555 family" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toBe('Chat "family" (55555) authorized.');
      });

      it("sends usage hint when args are missing", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsadd")!;

        handler({ chat: { id: 12345 }, match: "55555" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toContain("Usage:");
      });

      it("sends usage hint when match is empty", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsadd")!;

        handler({ chat: { id: 12345 }, match: "" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toContain("Usage:");
      });

      it("sends error for invalid chat name", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsadd")!;

        handler({ chat: { id: 12345 }, match: "55555 InvalidName" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toContain("Error:");
      });

      it("sends error for duplicate chat", async () => {
        const authorizedChats = new AuthorizedChats(tmpSettingsDir);
        authorizedChats.add("55555", "family");
        const app = makeApp({ authorizedChats });
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsadd")!;

        handler({ chat: { id: 12345 }, match: "55555 family" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toContain("Error:");
      });

      it("rejects chatId that matches the admin chat", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsadd")!;

        handler({ chat: { id: 12345 }, match: "12345 family" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toContain("already the admin chat");
      });

      it("is ignored for non-admin chats", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsadd")!;

        handler({ chat: { id: 99999 }, match: "55555 family" });
        await new Promise((r) => setTimeout(r, 50));

        expect((bot.api.sendMessage as any).mock.calls.length).toBe(0);
      });

      it("newly added chat can send messages", async () => {
        const config = makeConfig();
        const app = trackApp(new App(config));
        const bot = app.bot as any;

        const addHandler = bot.commandHandlers.get("chatsadd")!;
        addHandler({ chat: { id: 12345 }, match: "55555 family" });
        await new Promise((r) => setTimeout(r, 50));

        const claude = config.claude as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[] };
        const callsBefore = claude.calls.length;

        const textHandler = bot.filterHandlers.get("message:text")![0];
        textHandler({ chat: { id: 55555 }, message: { text: "hello from family" } });
        await new Promise((r) => setTimeout(r, 50));

        expect(claude.calls.length).toBeGreaterThan(callsBefore);
      });
    });

    describe("/chatsremove", () => {
      it("removes chat and clears its session", async () => {
        saveSessions({ mainSessions: { admin: "admin-sid", family: "fam-sid" } }, tmpSettingsDir);
        const authorizedChats = new AuthorizedChats(tmpSettingsDir);
        authorizedChats.add("55555", "family");
        const app = makeApp({ authorizedChats });
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsremove")!;

        await handler({ chat: { id: 12345 }, match: "family" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toBe('Chat "family" removed.');

        const sessions = loadSessions(tmpSettingsDir);
        expect(sessions.mainSessions.family).toBeUndefined();
        expect(sessions.mainSessions.admin).toBe("admin-sid");
      });

      it("reports when no chats to remove and no arg given", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsremove")!;

        await handler({ chat: { id: 12345 }, match: "" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toBe("No authorized chats to remove.");
      });

      it("sends chat-picker buttons when no arg and chats exist", async () => {
        const authorizedChats = new AuthorizedChats(tmpSettingsDir);
        authorizedChats.add("55555", "family");
        authorizedChats.add("66666", "work");
        const app = makeApp({ authorizedChats });
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsremove")!;

        await handler({ chat: { id: 12345 }, match: "" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall[1]).toBe("Which chat to remove?");
        const keyboard = lastCall[2].reply_markup.inline_keyboard.flat();
        const labels = keyboard.map((b: any) => b.text);
        expect(labels).toEqual(["family", "work", "Dismiss"]);
        expect(keyboard.find((b: any) => b.text === "family").callback_data).toBe("chatsremove:family");
      });

      it("button callback removes the selected chat", async () => {
        saveSessions({ mainSessions: { admin: "admin-sid", family: "fam-sid" } }, tmpSettingsDir);
        const authorizedChats = new AuthorizedChats(tmpSettingsDir);
        authorizedChats.add("55555", "family");
        const app = makeApp({ authorizedChats });
        const bot = app.bot as any;
        const handler = bot.filterHandlers.get("callback_query:data")![0];

        const ctx = {
          chat: { id: 12345 },
          callbackQuery: { data: "chatsremove:family" },
          answerCallbackQuery: mock(async () => {}),
          editMessageReplyMarkup: mock(async () => {}),
        };

        await handler(ctx);
        await new Promise((r) => setTimeout(r, 50));

        expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: { inline_keyboard: [[{ text: "✓ Removed family", callback_data: "_noop" }]] } });
        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toBe('Chat "family" removed.');

        const sessions = loadSessions(tmpSettingsDir);
        expect(sessions.mainSessions.family).toBeUndefined();
      });

      it("button callback is ignored for non-admin chats", async () => {
        const authorizedChats = new AuthorizedChats(tmpSettingsDir);
        authorizedChats.add("99999", "intruder");
        const app = makeApp({ authorizedChats });
        const bot = app.bot as any;
        const handler = bot.filterHandlers.get("callback_query:data")![0];

        const ctx = {
          chat: { id: 99999 },
          callbackQuery: { data: "chatsremove:intruder" },
          answerCallbackQuery: mock(async () => {}),
          editMessageReplyMarkup: mock(async () => {}),
        };

        await handler(ctx);
        await new Promise((r) => setTimeout(r, 50));

        // Intruder is still authorized
        expect(authorizedChats.byName("intruder")).toBeDefined();
      });

      it("sends error for unknown chat name", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsremove")!;

        await handler({ chat: { id: 12345 }, match: "ghost" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toContain("Error:");
      });

      it("ignores explicit-name removal from non-admin chats", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsremove")!;

        await handler({ chat: { id: 99999 }, match: "family" });
        await new Promise((r) => setTimeout(r, 50));

        expect((bot.api.sendMessage as any).mock.calls.length).toBe(0);
      });

      it("self-removes when called from non-admin chat with no arg", async () => {
        const authorizedChats = new AuthorizedChats(tmpSettingsDir);
        authorizedChats.add("55555", "family");
        saveSessions({ mainSessions: { admin: "a", family: "f" } }, tmpSettingsDir);
        const app = makeApp({ authorizedChats });
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsremove")!;

        await handler({ chat: { id: 55555 }, match: "" });
        await new Promise((r) => setTimeout(r, 50));

        const calls = (bot.api.sendMessage as any).mock.calls;
        expect(calls[calls.length - 1][1]).toBe('Chat "family" removed.');
        expect(authorizedChats.byName("family")).toBeUndefined();
        expect(loadSessions(tmpSettingsDir).mainSessions.family).toBeUndefined();
      });

      it("ignores no-arg self-removal from unauthorized non-admin chat", async () => {
        const app = makeApp();
        const bot = app.bot as any;
        const handler = bot.commandHandlers.get("chatsremove")!;

        await handler({ chat: { id: 77777 }, match: "" });
        await new Promise((r) => setTimeout(r, 50));

        expect((bot.api.sendMessage as any).mock.calls.length).toBe(0);
      });
    });
  });

  describe("handleCron", () => {
    it("routes cron job with no chat to admin orchestrator", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));

      const claude = config.claude as Claude & { calls: CallInfo[] };
      const callsBefore = claude.calls.length;
      app.handleCron("check-in", "any news?", undefined, undefined, undefined);
      await new Promise((r) => setTimeout(r, 50));

      expect(claude.calls.length).toBeGreaterThan(callsBefore);
    });

    it("routes cron job with chat:'admin' to admin orchestrator", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));

      const claude = config.claude as Claude & { calls: CallInfo[] };
      const callsBefore = claude.calls.length;
      app.handleCron("check-in", "any news?", undefined, undefined, "admin");
      await new Promise((r) => setTimeout(r, 50));

      expect(claude.calls.length).toBeGreaterThan(callsBefore);
    });

    it("routes cron job with chat name to that chat's orchestrator", async () => {
      const authorizedChats = new AuthorizedChats(tmpSettingsDir);
      authorizedChats.add("55555", "family");
      const config = makeConfig({ authorizedChats });
      const app = trackApp(new App(config));

      const claude = config.claude as Claude & { calls: CallInfo[] };
      const callsBefore = claude.calls.length;
      app.handleCron("family-update", "hello family", undefined, undefined, "family");
      await new Promise((r) => setTimeout(r, 50));

      expect(claude.calls.length).toBeGreaterThan(callsBefore);
    });

    it("broadcasts cron job with chat:'*' to all orchestrators", async () => {
      const authorizedChats = new AuthorizedChats(tmpSettingsDir);
      authorizedChats.add("55555", "family");
      const config = makeConfig({ authorizedChats });
      const app = trackApp(new App(config));

      const claude = config.claude as Claude & { calls: CallInfo[] };
      const callsBefore = claude.calls.length;
      app.handleCron("broadcast", "everyone", undefined, undefined, "*");
      await new Promise((r) => setTimeout(r, 50));

      // 2 orchestrators (admin + family) → at least 2 additional claude calls
      expect(claude.calls.length).toBeGreaterThanOrEqual(callsBefore + 2);
    });

    it("warns and does nothing for unknown chat name", async () => {
      const config = makeConfig();
      const app = trackApp(new App(config));

      const claude = config.claude as Claude & { calls: CallInfo[] };
      const callsBefore = claude.calls.length;
      app.handleCron("orphan", "hello?", undefined, undefined, "nobody");
      await new Promise((r) => setTimeout(r, 50));

      expect(claude.calls.length).toBe(callsBefore);
    });
  });

  describe("error handler", () => {
    it("does not throw on bot errors", () => {
      const app = makeApp();
      const bot = app.bot as any;

      expect(() => bot.errorHandler({ message: "connection lost" })).not.toThrow();
    });
  });

  describe("start", () => {
    it("starts the bot and logs info", () => {
      const app = makeApp();
      expect(() => app.start()).not.toThrow();
    });

    it("registers commands with Telegram on start", () => {
      const app = makeApp();
      const bot = app.bot as any;

      app.start();
      expect(bot.api.setMyCommands).toHaveBeenCalledWith([
        { command: "chatid", description: "Show current chat ID" },
        { command: "bg", description: "Spawn a background agent" },
        { command: "sessions", description: "List running sessions" },
        { command: "clear", description: "Clear session and start fresh" },
        { command: "chats", description: "List authorized chats (admin only)" },
        { command: "chatsadd", description: "Authorize a new chat (admin only)" },
        { command: "chatsremove", description: "Remove an authorized chat (admin only)" },
      ]);
    });
  });
});
