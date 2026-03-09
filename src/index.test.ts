import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { ClaudeResponse } from "./claude";
import { type AppConfig, createApp, requireEnv } from "./index";
import { PROMPT_BACKGROUND_RESULT, PROMPT_CRON_EVENT, PROMPT_USER_MESSAGE } from "./prompts";
import { saveSettings } from "./settings";

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
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
  saveSettings({ sessionId: "test-session" }, tmpSettingsDir);
});

afterEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    botToken: "test-token",
    authorizedChatId: "12345",
    workspace: "/tmp/macroclaw-test-workspace",
    settingsDir: tmpSettingsDir,
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

  it("registers message:text, message:photo, and message:document handlers", () => {
    const app = createApp(makeConfig());
    const bot = app.bot as any;
    expect(bot.filterHandlers.has("message:text")).toBe(true);
    expect(bot.filterHandlers.has("message:photo")).toBe(true);
    expect(bot.filterHandlers.has("message:document")).toBe(true);
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

  it("generates new session ID when settings is empty", () => {
    if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const app = createApp(makeConfig());
    const bot = app.bot as any;

    // /session should return a UUID, not "test-session"
    const ctx = { reply: mock(() => {}) };
    bot.commandHandlers.get("session")!(ctx);
    const reply = (ctx.reply as any).mock.calls[0][0];
    expect(reply).toMatch(/Session: `[0-9a-f]{8}-/);
    consoleSpy.mockRestore();
  });

  describe("session resolution", () => {
    it("uses --resume for existing session on first call", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalledWith("hello", "--resume", "test-session", undefined, "/tmp/macroclaw-test-workspace", PROMPT_USER_MESSAGE, 60_000, undefined);
    });

    it("creates new session when resume fails", async () => {
      let callCount = 0;
      const config = makeConfig({
        runClaude: mock(async (msg: string): Promise<ClaudeResponse> => {
          callCount++;
          if (callCount === 1) {
            return { action: "send", message: "[Error] session not found", reason: "process-error" };
          }
          return { action: "send", message: `Response to: ${msg}`, reason: "user message" };
        }),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(callCount).toBe(2);
      // First call: --resume with old session
      const firstCall = (config.runClaude as any).mock.calls[0];
      expect(firstCall[1]).toBe("--resume");
      expect(firstCall[2]).toBe("test-session");
      // Second call: --session-id with new UUID
      const secondCall = (config.runClaude as any).mock.calls[1];
      expect(secondCall[1]).toBe("--session-id");
      expect(secondCall[2]).not.toBe("test-session");
      expect(secondCall[2]).toMatch(/^[0-9a-f]{8}-/);
    });

    it("uses --session-id on first call when no settings exist", async () => {
      if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const call = (config.runClaude as any).mock.calls[0];
      expect(call[1]).toBe("--session-id");
      expect(call[2]).toMatch(/^[0-9a-f]{8}-/);
    });

    it("switches to --resume after first successful call", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "first" } });
      await new Promise((r) => setTimeout(r, 50));
      handler({ chat: { id: 12345 }, message: { text: "second" } });
      await new Promise((r) => setTimeout(r, 50));

      const firstCall = (config.runClaude as any).mock.calls[0];
      const secondCall = (config.runClaude as any).mock.calls[1];
      expect(firstCall[1]).toBe("--resume");
      expect(secondCall[1]).toBe("--resume");
    });
  });

  describe("message handler", () => {
    it("queues messages from authorized chat", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalledWith("hello", "--resume", "test-session", undefined, "/tmp/macroclaw-test-workspace", PROMPT_USER_MESSAGE, 60_000, undefined);
    });

    it("passes model override from queue item", async () => {
      const config = makeConfig();
      const app = createApp(config);

      app.queue.push({ message: "cron msg", model: "haiku" });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalledWith("cron msg", "--resume", "test-session", "haiku", "/tmp/macroclaw-test-workspace", PROMPT_USER_MESSAGE, 60_000, undefined);
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

    it("passes cron system prompt for cron messages", async () => {
      const config = makeConfig();
      const app = createApp(config);

      app.queue.push({ message: "[Tool: cron/daily-check] Check for updates", source: "cron", name: "daily-check" });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalledWith(
        "[Tool: cron/daily-check] Check for updates",
        "--resume",
        "test-session",
        undefined,
        "/tmp/macroclaw-test-workspace",
        PROMPT_CRON_EVENT,
        300_000,
        undefined,
      );
    });

    it("passes background result system prompt for background messages", async () => {
      const config = makeConfig();
      const app = createApp(config);

      app.queue.push({ message: "[Background: research] Here are the results", source: "background" });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalledWith(
        "[Background: research] Here are the results",
        "--resume",
        "test-session",
        undefined,
        "/tmp/macroclaw-test-workspace",
        PROMPT_BACKGROUND_RESULT,
        60_000,
        undefined,
      );
    });

    it("passes MAIN_TIMEOUT for user messages", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalledWith("hello", "--resume", "test-session", undefined, "/tmp/macroclaw-test-workspace", PROMPT_USER_MESSAGE, 60_000, undefined);
    });

    it("passes CRON_TIMEOUT for cron messages", async () => {
      const config = makeConfig();
      const app = createApp(config);

      app.queue.push({ message: "[Tool: cron/daily-check] Check for updates", source: "cron", name: "daily-check" });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalledWith(
        "[Tool: cron/daily-check] Check for updates",
        "--resume",
        "test-session",
        undefined,
        "/tmp/macroclaw-test-workspace",
        PROMPT_CRON_EVENT,
        300_000,
        undefined,
      );
    });

    it("re-queues user message with [Timeout] prefix on timeout", async () => {
      let callCount = 0;
      const config = makeConfig({
        runClaude: mock(async (_msg: string): Promise<ClaudeResponse> => {
          callCount++;
          if (callCount === 1) {
            return { action: "send", message: "[Error] timed out", reason: "timeout" };
          }
          // The re-queued [Timeout] message
          return { action: "send", message: "handled via retry", reason: "ok" };
        }),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "do something slow" } });
      await new Promise((r) => setTimeout(r, 100));

      // First call: user message times out
      // Second call: re-queued [Timeout] message
      expect(callCount).toBe(2);
      const secondCall = (config.runClaude as any).mock.calls[1][0];
      expect(secondCall).toStartWith("[Timeout]");
      expect(secondCall).toContain("do something slow");

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain("Request timed out. Retrying as a background task...");
    });

    it("does not re-queue timeout messages that also time out", async () => {
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => {
          return { action: "send", message: "[Error] timed out again", reason: "timeout" };
        }),
      });
      const app = createApp(config);

      app.queue.push({ message: "[Timeout] previously timed out", source: "timeout" });
      await new Promise((r) => setTimeout(r, 50));

      // Should NOT re-queue — only one call
      expect(config.runClaude).toHaveBeenCalledTimes(1);
      const bot = app.bot as any;
      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain("[Error] timed out again");
    });

    it("sends cron timeout notification on cron timeout", async () => {
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => {
          return { action: "send", message: "[Error] timed out", reason: "timeout" };
        }),
      });
      const app = createApp(config);

      app.queue.push({ message: "[Tool: cron/daily-check] Check for updates", source: "cron", name: "daily-check" });
      await new Promise((r) => setTimeout(r, 50));

      const bot = app.bot as any;
      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain('Cron job "daily-check" timed out after 300 seconds.');
    });

    it("handles background result timeout like user message timeout", async () => {
      let callCount = 0;
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => {
          callCount++;
          if (callCount === 1) {
            return { action: "send", message: "[Error] timed out", reason: "timeout" };
          }
          return { action: "send", message: "ok", reason: "ok" };
        }),
      });
      const app = createApp(config);

      app.queue.push({ message: "[Background: research] long result", source: "background" });
      await new Promise((r) => setTimeout(r, 100));

      expect(callCount).toBe(2);
      const secondCall = (config.runClaude as any).mock.calls[1][0];
      expect(secondCall).toStartWith("[Timeout]");
      expect(secondCall).toContain("[Background: research] long result");
    });

    it("sends error wrapped in ClaudeResponse", async () => {
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => {
          // First call triggers session resolution retry, second also fails
          return { action: "send", message: "[Error] Claude exited with code 1:\nspawn failed", reason: "process-error" };
        }),
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

    it("handles photo messages by downloading and queuing with files", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-image", { status: 200 })),
      ) as any;

      const config = makeConfig();
      const app = createApp(config);
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
      expect(config.runClaude).toHaveBeenCalled();
      const call = (config.runClaude as any).mock.calls[0];
      expect(call[0]).toBe("check this");
      expect(call[7]).toBeDefined();
      expect(call[7][0]).toContain("/tmp/macroclaw/inbound/");

      globalThis.fetch = origFetch;
    });

    it("handles document messages by downloading and queuing with files", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("fake-doc", { status: 200 })),
      ) as any;

      const config = makeConfig();
      const app = createApp(config);
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
      expect(config.runClaude).toHaveBeenCalled();
      const call = (config.runClaude as any).mock.calls[0];
      expect(call[0]).toBe("review this");
      expect(call[7][0]).toContain("report.pdf");

      globalThis.fetch = origFetch;
    });

    it("queues error message when photo download fails", async () => {
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      bot.api.getFile = mock(async () => { throw new Error("too large"); });
      const handler = bot.filterHandlers.get("message:photo")![0];

      await handler({
        chat: { id: 12345 },
        message: { caption: "big photo", photo: [{ file_id: "big" }] },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalled();
      const msg = (config.runClaude as any).mock.calls[0][0];
      expect(msg).toContain("[File download failed: photo.jpg]");
      consoleSpy.mockRestore();
    });

    it("queues error message when document download fails", async () => {
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      bot.api.getFile = mock(async () => { throw new Error("too large"); });
      const handler = bot.filterHandlers.get("message:document")![0];

      await handler({
        chat: { id: 12345 },
        message: { caption: "big doc", document: { file_id: "big", file_name: "huge.pdf" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).toHaveBeenCalled();
      const msg = (config.runClaude as any).mock.calls[0][0];
      expect(msg).toContain("[File download failed: huge.pdf]");
      consoleSpy.mockRestore();
    });

    it("ignores photo messages from unauthorized chats", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:photo")![0];

      await handler({
        chat: { id: 99999 },
        message: { photo: [{ file_id: "x" }] },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(config.runClaude).not.toHaveBeenCalled();
    });

    it("sends outbound files before text message", async () => {
      const tmpFile = `/tmp/macroclaw-test-outbound-${Date.now()}.png`;
      await Bun.write(tmpFile, "fake png");

      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => ({
          action: "send",
          message: "Here's your chart",
          reason: "ok",
          files: [tmpFile],
        })),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "make a chart" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1);
      expect(bot.api.sendMessage).toHaveBeenCalled();

      const { rm } = await import("node:fs/promises");
      await rm(tmpFile, { force: true });
    });

    it("skips outbound files that don't exist", async () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResponse> => ({
          action: "send",
          message: "Done",
          reason: "ok",
          files: ["/tmp/nonexistent-xyz.png"],
        })),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.sendPhoto).not.toHaveBeenCalled();
      expect(bot.api.sendMessage).toHaveBeenCalled();
      warnSpy.mockRestore();
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

    it("registers commands with Telegram on start", () => {
      const app = createApp(makeConfig());
      const bot = app.bot as any;

      app.start();
      expect(bot.api.setMyCommands).toHaveBeenCalledWith([
        { command: "chatid", description: "Show current chat ID" },
        { command: "session", description: "Show current session ID" },
        { command: "bg", description: "List background agents" },
      ]);
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
