import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { App, type AppConfig } from "./app";
import type { Claude, ClaudeDeferredResult, ClaudeResult, ClaudeRunOptions } from "./claude";
import { saveSettings } from "./settings";

const mockOpenAICreate = mock(async () => ({ text: "transcribed text" }));

mock.module("openai", () => ({
  default: class MockOpenAI {
    audio = {
      transcriptions: {
        create: mockOpenAICreate,
      },
    };
  },
}));

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

const savedOpenAIKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
  saveSettings({ sessionId: "test-session" }, tmpSettingsDir);
});

afterEach(() => {
  if (savedOpenAIKey) process.env.OPENAI_API_KEY = savedOpenAIKey;
  else delete process.env.OPENAI_API_KEY;
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

function successResult(output: unknown, sessionId = "test-session-id"): ClaudeResult {
  return { structuredOutput: output, sessionId, duration: "1.0s", cost: "$0.05" };
}

function mockClaude(handler: (opts: ClaudeRunOptions) => Promise<ClaudeResult | ClaudeDeferredResult>): Claude {
  const claude = { run: mock(handler) };
  return claude as unknown as Claude;
}

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    botToken: "test-token",
    authorizedChatId: "12345",
    workspace: "/tmp/macroclaw-test-workspace",
    settingsDir: tmpSettingsDir,
    claude: mockClaude(async (opts: ClaudeRunOptions): Promise<ClaudeResult> =>
      successResult({ action: "send", message: `Response to: ${opts.prompt}`, actionReason: "user message" }),
    ),
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

  it("registers chatid, session, and bg commands", () => {
    const app = new App(makeConfig());
    const bot = app.bot as any;
    expect(bot.commandHandlers.has("chatid")).toBe(true);
    expect(bot.commandHandlers.has("session")).toBe(true);
    expect(bot.commandHandlers.has("bg")).toBe(true);
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

      const claude = config.claude as any;
      const opts = claude.run.mock.calls[0][0] as ClaudeRunOptions;
      expect(opts.prompt).toBe("hello");
    });

    it("ignores messages from unauthorized chats", async () => {
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 99999 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect((config.claude as any).run).not.toHaveBeenCalled();
    });

    it("sends [No output] for empty claude response", async () => {
      const config = makeConfig({
        claude: mockClaude(async (): Promise<ClaudeResult> => successResult({ action: "send", message: "", actionReason: "empty" })),
      });
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
      const config = makeConfig({
        claude: mockClaude(async (): Promise<ClaudeResult> => successResult({ action: "silent", actionReason: "no new results" })),
      });
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

      const opts = (config.claude as any).run.mock.calls[0][0] as ClaudeRunOptions;
      expect(opts.prompt).toBe("bg: research pricing");
    });

    it("sends error wrapped in ClaudeResponse", async () => {
      const { ClaudeProcessError } = await import("./claude");
      const config = makeConfig({
        claude: mockClaude(async (): Promise<ClaudeResult> => {
          throw new ClaudeProcessError(1, "spawn failed");
        }),
      });
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
      expect((config.claude as any).run).toHaveBeenCalled();
      const opts = (config.claude as any).run.mock.calls[0][0] as ClaudeRunOptions;
      expect(opts.prompt).toContain("[File:");

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
      expect((config.claude as any).run).toHaveBeenCalled();
      const opts = (config.claude as any).run.mock.calls[0][0] as ClaudeRunOptions;
      expect(opts.prompt).toContain("[File:");

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

      expect((config.claude as any).run).toHaveBeenCalled();
      const opts = (config.claude as any).run.mock.calls[0][0] as ClaudeRunOptions;
      expect(opts.prompt).toContain("[File download failed: photo.jpg]");
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

      expect((config.claude as any).run).toHaveBeenCalled();
      const opts = (config.claude as any).run.mock.calls[0][0] as ClaudeRunOptions;
      expect(opts.prompt).toContain("[File download failed: huge.pdf]");
    });

    it("handles voice messages by transcribing and routing text to orchestrator", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-audio", { status: 200 })),
      ) as any;
      mockOpenAICreate.mockImplementationOnce(async () => ({ text: "hello from voice" }));

      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:voice")![0];

      await handler({
        chat: { id: 12345 },
        message: { voice: { file_id: "voice-id", duration: 5 } },
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should echo transcription to user
      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const echoCall = sendCalls.find((c: any) => c[1].includes("[Received audio]"));
      expect(echoCall).toBeDefined();
      expect(echoCall[1]).toContain("hello from voice");

      // Should route transcribed text to orchestrator
      expect((config.claude as any).run).toHaveBeenCalled();
      const opts = (config.claude as any).run.mock.calls[0][0] as ClaudeRunOptions;
      expect(opts.prompt).toBe("hello from voice");

      globalThis.fetch = origFetch;
    });

    it("sends error message when voice transcription fails", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-audio", { status: 200 })),
      ) as any;
      mockOpenAICreate.mockImplementationOnce(async () => { throw new Error("API error"); });

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
      expect((config.claude as any).run).not.toHaveBeenCalled();

      globalThis.fetch = origFetch;
    });

    it("sends message when voice transcription returns empty text", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-audio", { status: 200 })),
      ) as any;
      mockOpenAICreate.mockImplementationOnce(async () => ({ text: "  " }));

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
      expect((config.claude as any).run).not.toHaveBeenCalled();

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

      expect((config.claude as any).run).not.toHaveBeenCalled();
    });

    it("responds with unavailable message when OPENAI_API_KEY is not set", async () => {
      delete process.env.OPENAI_API_KEY;
      const config = makeConfig();
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:voice")![0];

      await handler({
        chat: { id: 12345 },
        message: { voice: { file_id: "voice-id", duration: 5 } },
      });

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const call = sendCalls.find((c: any) => c[1].includes("OPENAI_API_KEY"));
      expect(call).toBeDefined();
      expect((config.claude as any).run).not.toHaveBeenCalled();
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

      expect((config.claude as any).run).not.toHaveBeenCalled();
    });

    it("sends outbound files before text message (onResponse delivery)", async () => {
      const tmpFile = `/tmp/macroclaw-test-outbound-${Date.now()}.png`;
      await Bun.write(tmpFile, "fake png");

      const config = makeConfig({
        claude: mockClaude(async (): Promise<ClaudeResult> =>
          successResult({
            action: "send",
            message: "Here's your chart",
            actionReason: "ok",
            files: [tmpFile],
          }),
        ),
      });
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
      const config = makeConfig({
        claude: mockClaude(async (): Promise<ClaudeResult> =>
          successResult({
            action: "send",
            message: "Choose one",
            actionReason: "ok",
            buttons: ["Yes", "No"],
          }),
        ),
      });
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
      expect((config.claude as any).run).toHaveBeenCalled();
      const opts = (config.claude as any).run.mock.calls[0][0] as ClaudeRunOptions;
      expect(opts.prompt).toBe('[Context: button-click] User tapped "Yes"');
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
      expect((config.claude as any).run).not.toHaveBeenCalled();
    });

    it("skips outbound files that don't exist", async () => {
      const config = makeConfig({
        claude: mockClaude(async (): Promise<ClaudeResult> =>
          successResult({
            action: "send",
            message: "Done",
            actionReason: "ok",
            files: ["/tmp/nonexistent-xyz.png"],
          }),
        ),
      });
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

    it("/session sends session ID via sendMessage", async () => {
      const app = new App(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("session")!;
      const ctx = { chat: { id: 12345 } };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const text = calls[calls.length - 1][1];
      expect(text).toBe("Session: <code>test-session</code>");
    });

    it("/session is ignored for unauthorized chats", async () => {
      const app = new App(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("session")!;
      const ctx = { chat: { id: 99999 } };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect((bot.api.sendMessage as any).mock.calls.length).toBe(0);
    });

    it("/bg shows no agents via sendMessage when none are running", async () => {
      const app = new App(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("bg")!;
      const ctx = { chat: { id: 12345 }, match: "" };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toBe("No background agents running.");
    });

    it("/bg with prompt spawns a background agent via sendMessage", async () => {
      const config = makeConfig({
        claude: mockClaude(() => new Promise<ClaudeResult>(() => {})),
      });
      const app = new App(config);
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("bg")!;
      const ctx = { chat: { id: 12345 }, match: "research pricing" };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toBe('Background agent "research-pricing" started.');
      expect((config.claude as any).run).toHaveBeenCalledTimes(1);
    });

    it("/bg lists active background agents via sendMessage", async () => {
      const config = makeConfig({
        claude: mockClaude(() => new Promise<ClaudeResult>(() => {})),
      });
      const app = new App(config);
      const bot = app.bot as any;
      const bgHandler = bot.commandHandlers.get("bg")!;

      // Spawn via /bg command
      const spawnCtx = { chat: { id: 12345 }, match: "long task" };
      bgHandler(spawnCtx);
      await new Promise((r) => setTimeout(r, 10));

      // List via /bg with no args
      const listCtx = { chat: { id: 12345 }, match: "" };
      bgHandler(listCtx);
      await new Promise((r) => setTimeout(r, 10));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const lastText = calls[calls.length - 1][1];
      expect(lastText).toContain("long-task");
      expect(lastText).toMatch(/\d+s/);
    });

    it("generates new session ID when settings is empty", async () => {
      if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
      const app = new App(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("session")!;
      const ctx = { chat: { id: 12345 } };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const text = calls[calls.length - 1][1];
      expect(text).toMatch(/Session: <code>[0-9a-f]{8}-/);
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
        { command: "session", description: "Show current session ID" },
        { command: "bg", description: "List or spawn background agents" },
      ]);
    });
  });
});
