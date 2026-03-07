import { describe, it, expect, mock, spyOn } from "bun:test";
import { createApp, requireEnv, type AppConfig } from "./index";

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

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    botToken: "test-token",
    authorizedChatId: "12345",
    sessionId: "test-session",
    runClaude: mock(async (msg: string) => `Response to: ${msg}`),
    ...overrides,
  };
}

describe("createApp", () => {
  it("creates bot and queue", () => {
    const app = createApp(makeConfig());
    expect(app.bot).toBeDefined();
    expect(app.queue).toBeDefined();
  });

  it("registers message:text handler", () => {
    const app = createApp(makeConfig());
    const bot = app.bot as any;
    expect(bot.filterHandlers.has("message:text")).toBe(true);
  });

  it("registers chatid and session commands", () => {
    const app = createApp(makeConfig());
    const bot = app.bot as any;
    expect(bot.commandHandlers.has("chatid")).toBe(true);
    expect(bot.commandHandlers.has("session")).toBe(true);
  });

  it("registers error handler", () => {
    const app = createApp(makeConfig());
    const bot = app.bot as any;
    expect(bot.errorHandler).not.toBeNull();
  });

  describe("message handler", () => {
    it("queues messages from authorized chat", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalledWith("hello", "test-session");
      expect(bot.api.sendMessage).toHaveBeenCalled();
    });

    it("ignores messages from unauthorized chats", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 99999 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).not.toHaveBeenCalled();
    });

    it("ignores commands starting with /", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "/start" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).not.toHaveBeenCalled();
    });

    it("sends [No output] for empty claude response", async () => {
      const config = makeConfig({
        runClaude: mock(async () => ""),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const lastText = calls[calls.length - 1][1];
      expect(lastText).toBe("[No output]");
    });

    it("sends error message when claude throws", async () => {
      const config = makeConfig({
        runClaude: mock(async () => { throw new Error("spawn failed"); }),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const lastText = calls[calls.length - 1][1];
      expect(lastText).toContain("[Error]");
      expect(lastText).toContain("spawn failed");
    });

    it("sends error message for non-Error throws", async () => {
      const config = makeConfig({
        runClaude: mock(async () => { throw "string error"; }),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const lastText = calls[calls.length - 1][1];
      expect(lastText).toContain("[Error] Unknown error");
    });
  });

  describe("commands", () => {
    it("/chatid replies with chat ID", () => {
      const app = createApp(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("chatid")!;
      const ctx = { chat: { id: 12345 }, reply: mock(() => {}) };

      handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith("Chat ID: `12345`", { parse_mode: "Markdown" });
    });

    it("/session replies with session ID", () => {
      const app = createApp(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("session")!;
      const ctx = { reply: mock(() => {}) };

      handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith("Session: `test-session`", { parse_mode: "Markdown" });
    });
  });

  describe("error handler", () => {
    it("logs bot errors to console", () => {
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
      const app = createApp(makeConfig());
      const bot = app.bot as any;

      bot.errorHandler({ message: "connection lost" });
      expect(consoleSpy).toHaveBeenCalledWith("Bot error:", "connection lost");
      consoleSpy.mockRestore();
    });
  });

  describe("start", () => {
    it("starts the bot and logs info", () => {
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
      const app = createApp(makeConfig());

      app.start();
      expect(consoleSpy).toHaveBeenCalledWith("Starting macroclaw...");
      expect(consoleSpy).toHaveBeenCalledWith("Bot connected: @test_bot");
      expect(consoleSpy).toHaveBeenCalledWith("Authorized chat: 12345");
      expect(consoleSpy).toHaveBeenCalledWith("Session: test-session");
      consoleSpy.mockRestore();
    });
  });
});

describe("requireEnv", () => {
  it("returns the env value when set", () => {
    process.env.TEST_VAR_MACROCLAW = "hello";
    expect(requireEnv("TEST_VAR_MACROCLAW")).toBe("hello");
    delete process.env.TEST_VAR_MACROCLAW;
  });

  it("exits when env var is missing", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(() => requireEnv("NONEXISTENT_VAR_XYZ")).toThrow("exit");
    expect(consoleSpy).toHaveBeenCalledWith("Missing NONEXISTENT_VAR_XYZ in environment");

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
