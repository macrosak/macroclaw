import { describe, it, expect, mock, spyOn } from "bun:test";
import { createApp, requireEnv, type AppConfig } from "./index";
import type { ClaudeResponse } from "./claude";

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
    workspace: "/tmp/macroclaw-test-workspace",
    runClaude: mock(async (msg: string): Promise<ClaudeResponse> => ({ action: "send", message: `Response to: ${msg}`, reason: "user message" })),
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

  it("registers chatid, session, and bg commands", () => {
    const app = createApp(makeConfig());
    const bot = app.bot as any;
    expect(bot.commandHandlers.has("chatid")).toBe(true);
    expect(bot.commandHandlers.has("session")).toBe(true);
    expect(bot.commandHandlers.has("bg")).toBe(true);
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

      expect(config.runClaude).toHaveBeenCalledWith("hello", "test-session", undefined, "/tmp/macroclaw-test-workspace");
    });

    it("passes model override from queue item", async () => {
      const config = makeConfig();
      const app = createApp(config);

      app.queue.push({ message: "cron msg", model: "haiku" });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalledWith("cron msg", "test-session", "haiku", "/tmp/macroclaw-test-workspace");
      const bot = app.bot as any;
      expect(bot.api.sendMessage).toHaveBeenCalled();
    });

    it("ignores messages from unauthorized chats and logs chat id", async () => {
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 99999 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("[unauthorized] chat_id=99999");
      consoleSpy.mockRestore();
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
        runClaude: mock(async (): Promise<ClaudeResponse> => ({ action: "send", message: "", reason: "empty" })),
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

    it("skips sending when action is silent", async () => {
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => ({ action: "silent", message: "", reason: "no new results" })),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.sendMessage).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("[response] action=silent reason=no new results message=");
      expect(consoleSpy).toHaveBeenCalledWith("[silent] (no message)");
      consoleSpy.mockRestore();
    });

    it("spawns background agent when action is background", async () => {
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
      let callCount = 0;
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => {
          callCount++;
          if (callCount === 1) {
            return { action: "background", message: "research this", reason: "needs research", name: "research" };
          }
          // The background agent's call
          return { action: "send", message: "research result", reason: "done" };
        }),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      // Main session got the background response and confirmed to user
      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain('Background agent "research" started.');

      // Background agent result should be fed back into queue
      await new Promise((r) => setTimeout(r, 100));
      expect(config.runClaude).toHaveBeenCalledTimes(3); // 1 main + 1 bg agent + 1 bg result fed back
      consoleSpy.mockRestore();
    });

    it("spawns background agent with unnamed when name is missing", async () => {
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
      let callCount = 0;
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => {
          callCount++;
          if (callCount === 1) {
            return { action: "background", message: "do something", reason: "bg" };
          }
          return { action: "send", message: "done", reason: "ok" };
        }),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain('Background agent "unnamed" started.');
      consoleSpy.mockRestore();
    });

    it("handles bg: prefix from Telegram", async () => {
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
      // Never-resolving mock so bg agent stays "running" and doesn't feed back
      const config = makeConfig({
        runClaude: mock(() => new Promise<ClaudeResponse>(() => {})),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];
      const ctx = {
        chat: { id: 12345 },
        message: { text: "bg: research pricing" },
        reply: mock(() => {}),
      };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      // Should NOT go through main queue — only the bg agent's runClaude call
      expect(config.runClaude).toHaveBeenCalledTimes(1);
      expect(ctx.reply).toHaveBeenCalledWith('Background agent "research-pricing" started.');
      consoleSpy.mockRestore();
    });

    it("sends error wrapped in ClaudeResponse", async () => {
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => ({ action: "send", message: "[Error] Claude exited with code 1:\nspawn failed", reason: "process-error" })),
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

    it("/bg shows no agents when none are running", () => {
      const app = createApp(makeConfig());
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("bg")!;
      const ctx = { reply: mock(() => {}) };

      handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith("No background agents running.");
    });

    it("/bg lists active background agents", async () => {
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
      // runClaude that never resolves (agent stays active)
      const config = makeConfig({
        runClaude: mock(() => new Promise<ClaudeResponse>(() => {})),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const msgHandler = bot.filterHandlers.get("message:text")![0];

      // Spawn a bg agent via bg: prefix
      const ctx = {
        chat: { id: 12345 },
        message: { text: "bg: long task" },
        reply: mock(() => {}),
      };
      msgHandler(ctx);
      await new Promise((r) => setTimeout(r, 10));

      const bgHandler = bot.commandHandlers.get("bg")!;
      const bgCtx = { reply: mock(() => {}) };
      bgHandler(bgCtx);

      const reply = (bgCtx.reply as any).mock.calls[0][0];
      expect(reply).toContain("long-task");
      expect(reply).toMatch(/\d+s/);
      consoleSpy.mockRestore();
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
