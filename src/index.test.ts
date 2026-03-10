import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { ClaudeOptions, ClaudeResult } from "./claude";
import { type AppConfig, createApp, requireEnv } from "./index";
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

function successResult(output: unknown, sessionId = "test-session-id"): ClaudeResult {
  return { structuredOutput: output, sessionId, duration: "1.0s", cost: "$0.05" };
}

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    botToken: "test-token",
    authorizedChatId: "12345",
    workspace: "/tmp/macroclaw-test-workspace",
    settingsDir: tmpSettingsDir,
    runClaude: mock(async (opts: ClaudeOptions): Promise<ClaudeResult> =>
      successResult({ action: "send", message: `Response to: ${opts.prompt}`, actionReason: "user message" }),
    ),
    ...overrides,
  };
}

describe("createApp", () => {
  it("creates bot and queue", () => {
    const app = createApp(makeConfig());
    expect(app.bot).toBeDefined();
    expect(app.queue).toBeDefined();
  });

  it("registers message:text, message:photo, message:document, and callback_query:data handlers", () => {
    const app = createApp(makeConfig());
    const bot = app.bot as any;
    expect(bot.filterHandlers.has("message:text")).toBe(true);
    expect(bot.filterHandlers.has("message:photo")).toBe(true);
    expect(bot.filterHandlers.has("message:document")).toBe(true);
    expect(bot.filterHandlers.has("callback_query:data")).toBe(true);
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
    const app = createApp(makeConfig());
    const bot = app.bot as any;

    const ctx = { reply: mock(() => {}) };
    bot.commandHandlers.get("session")!(ctx);
    const reply = (ctx.reply as any).mock.calls[0][0];
    expect(reply).toMatch(/Session: `[0-9a-f]{8}-/);
  });

  describe("message handler", () => {
    it("queues messages from authorized chat", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const opts = (config.runClaude as any).mock.calls[0][0] as ClaudeOptions;
      expect(opts.prompt).toBe("hello");
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

    it("sends [No output] for empty claude response", async () => {
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult> => successResult({ action: "send", message: "", actionReason: "empty" })),
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
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult> => successResult({ action: "silent", actionReason: "no new results" })),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it("spawns background agents from send response", async () => {
      let callCount = 0;
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult> => {
          callCount++;
          if (callCount === 1) {
            return successResult({
              action: "send",
              message: "Starting research",
              actionReason: "needs research",
              backgroundAgents: [{ name: "research", prompt: "research this" }],
            });
          }
          return successResult({ action: "send", message: "research result", actionReason: "done" });
        }),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain("Starting research");
      expect(texts).toContain('Background agent "research" started.');

      // Background agent result should be fed back into queue
      await new Promise((r) => setTimeout(r, 100));
      expect(config.runClaude).toHaveBeenCalledTimes(3); // 1 main + 1 bg agent + 1 bg result fed back
    });

    it("spawns background agents from silent response", async () => {
      let callCount = 0;
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult> => {
          callCount++;
          if (callCount === 1) {
            return successResult({
              action: "silent",
              actionReason: "spawning bg task",
              backgroundAgents: [{ name: "cleanup", prompt: "tidy up" }],
            });
          }
          return successResult({ action: "send", message: "done", actionReason: "ok" });
        }),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain('Background agent "cleanup" started.');
    });

    it("does not treat bg: prefix as special", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "bg: research pricing" } });
      await new Promise((r) => setTimeout(r, 50));

      const opts = (config.runClaude as any).mock.calls[0][0] as ClaudeOptions;
      expect(opts.prompt).toBe("bg: research pricing");
    });

    it("passes cron system prompt for cron messages", async () => {
      const config = makeConfig();
      const app = createApp(config);

      app.queue.push({ type: "cron", name: "daily-check", prompt: "Check for updates" });
      await new Promise((r) => setTimeout(r, 50));

      const opts = (config.runClaude as any).mock.calls[0][0] as ClaudeOptions;
      expect(opts.prompt).toBe("[Tool: cron/daily-check] Check for updates");
      expect(opts.systemPrompt).toContain("cron event");
      expect(opts.timeoutMs).toBe(300_000);
    });

    it("passes background result system prompt for background messages", async () => {
      const config = makeConfig();
      const app = createApp(config);

      app.queue.push({ type: "background", name: "research", result: "Here are the results" });
      await new Promise((r) => setTimeout(r, 50));

      const opts = (config.runClaude as any).mock.calls[0][0] as ClaudeOptions;
      expect(opts.prompt).toBe("[Background: research] Here are the results");
      expect(opts.systemPrompt).toContain("background agent you previously spawned");
      expect(opts.timeoutMs).toBe(60_000);
    });

    it("backgrounds deferred requests and sends notification", async () => {
      let resolveCompletion: (r: ClaudeResult) => void;
      const completion = new Promise<ClaudeResult>((r) => { resolveCompletion = r; });
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult | import("./claude").ClaudeDeferredResult> =>
          ({ deferred: true, sessionId: "test-session", completion }),
        ),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "do something slow" } });
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain("This is taking longer, continuing in the background.");

      // Complete the deferred task
      resolveCompletion!(successResult({ action: "send", message: "done!", actionReason: "ok" }));
      await new Promise((r) => setTimeout(r, 100));

      // Background result should be fed back
      const allTexts = (bot.api.sendMessage as any).mock.calls.map((c: any) => c[1]);
      expect(allTexts).toContain("done!");
    });

    it("backgrounds deferred cron requests", async () => {
      let resolveCompletion: (r: ClaudeResult) => void;
      const completion = new Promise<ClaudeResult>((r) => { resolveCompletion = r; });
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult | import("./claude").ClaudeDeferredResult> =>
          ({ deferred: true, sessionId: "test-session", completion }),
        ),
      });
      const app = createApp(config);
      const bot = app.bot as any;

      app.queue.push({ type: "cron", name: "daily-check", prompt: "Check for updates" });
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain("This is taking longer, continuing in the background.");

      resolveCompletion!(successResult({ action: "send", message: "cron done", actionReason: "ok" }));
      await new Promise((r) => setTimeout(r, 100));

      const allTexts = (bot.api.sendMessage as any).mock.calls.map((c: any) => c[1]);
      expect(allTexts).toContain("cron done");
    });

    it("applies background result directly when session IDs match", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;

      // Push a background result with matching sessionId
      app.queue.push({ type: "background", name: "task", result: "direct result", sessionId: "test-session" });
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = (bot.api.sendMessage as any).mock.calls;
      const texts = sendCalls.map((c: any) => c[1]);
      expect(texts).toContain("direct result");
      // Should NOT have called runClaude for this
      expect(config.runClaude).not.toHaveBeenCalled();
    });

    it("processes background result through orchestrator when session IDs differ", async () => {
      const config = makeConfig();
      const app = createApp(config);

      app.queue.push({ type: "background", name: "task", result: "indirect result", sessionId: "different-session" });
      await new Promise((r) => setTimeout(r, 50));

      // Should have called runClaude to process through orchestrator
      expect(config.runClaude).toHaveBeenCalled();
    });

    it("forks session when bg task runs on main session", async () => {
      let resolveCompletion: (r: ClaudeResult) => void;
      const completion = new Promise<ClaudeResult>((r) => { resolveCompletion = r; });
      let callCount = 0;
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult | import("./claude").ClaudeDeferredResult> => {
          callCount++;
          if (callCount === 1) return { deferred: true, sessionId: "test-session", completion };
          return successResult({ action: "send", message: "forked response", actionReason: "ok" });
        }),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      // First message gets deferred (backgrounded on test-session)
      handler({ chat: { id: 12345 }, message: { text: "slow task" } });
      await new Promise((r) => setTimeout(r, 50));

      // Second message should trigger a fork
      handler({ chat: { id: 12345 }, message: { text: "follow up" } });
      await new Promise((r) => setTimeout(r, 50));

      const opts = (config.runClaude as any).mock.calls[1][0] as ClaudeOptions;
      expect(opts.forkSession).toBe(true);

      resolveCompletion!(successResult({ action: "send", message: "bg done", actionReason: "ok" }));
      await new Promise((r) => setTimeout(r, 50));
    });

    it("sends error wrapped in ClaudeResponse", async () => {
      const { ClaudeProcessError } = await import("./claude");
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult> => {
          throw new ClaudeProcessError(1, "spawn failed");
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
      const opts = (config.runClaude as any).mock.calls[0][0] as ClaudeOptions;
      expect(opts.prompt).toContain("[File:");

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
      const opts = (config.runClaude as any).mock.calls[0][0] as ClaudeOptions;
      expect(opts.prompt).toContain("[File:");

      globalThis.fetch = origFetch;
    });

    it("queues error message when photo download fails", async () => {
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
      const opts = (config.runClaude as any).mock.calls[0][0] as ClaudeOptions;
      expect(opts.prompt).toContain("[File download failed: photo.jpg]");
    });

    it("queues error message when document download fails", async () => {
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
      const opts = (config.runClaude as any).mock.calls[0][0] as ClaudeOptions;
      expect(opts.prompt).toContain("[File download failed: huge.pdf]");
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
        runClaude: mock(async (): Promise<ClaudeResult> =>
          successResult({
            action: "send",
            message: "Here's your chart",
            actionReason: "ok",
            files: [tmpFile],
          }),
        ),
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

    it("passes buttons to sendResponse", async () => {
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult> =>
          successResult({
            action: "send",
            message: "Choose one",
            actionReason: "ok",
            buttons: [[{ label: "Yes" }, { label: "No" }]],
          }),
        ),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("message:text")![0];

      handler({ chat: { id: 12345 }, message: { text: "hello" } });
      await new Promise((r) => setTimeout(r, 50));

      const calls = (bot.api.sendMessage as any).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[2].reply_markup).toBeDefined();
    });

    it("handles callback_query by pushing button event to queue", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("callback_query:data")![0];

      const ctx = {
        chat: { id: 12345 },
        callbackQuery: { data: "Yes", message: { text: "Choose one" } },
        answerCallbackQuery: mock(async () => {}),
        editMessageText: mock(async () => {}),
      };

      await handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(ctx.editMessageText).toHaveBeenCalledWith("Choose one\n\n<i>Selected: Yes</i>", { parse_mode: "HTML" });
      expect(config.runClaude).toHaveBeenCalled();
      const opts = (config.runClaude as any).mock.calls[0][0] as ClaudeOptions;
      expect(opts.prompt).toBe('The user clicked MessageButton: "Yes"');
    });

    it("ignores callback_query from unauthorized chats", async () => {
      const config = makeConfig();
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.filterHandlers.get("callback_query:data")![0];

      const ctx = {
        chat: { id: 99999 },
        callbackQuery: { data: "Yes", message: { text: "Choose" } },
        answerCallbackQuery: mock(async () => {}),
        editMessageText: mock(async () => {}),
      };

      await handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
      expect(config.runClaude).not.toHaveBeenCalled();
    });

    it("skips outbound files that don't exist", async () => {
      const config = makeConfig({
        runClaude: mock(async (): Promise<ClaudeResult> =>
          successResult({
            action: "send",
            message: "Done",
            actionReason: "ok",
            files: ["/tmp/nonexistent-xyz.png"],
          }),
        ),
      });
      const app = createApp(config);
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
      const ctx = { chat: { id: 12345 }, match: "", reply: mock(() => {}) };

      handler(ctx);
      expect(ctx.reply).toHaveBeenCalledWith("No background agents running.");
    });

    it("/bg with prompt spawns a background agent", async () => {
      const config = makeConfig({
        runClaude: mock(() => new Promise<ClaudeResult>(() => {})),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const handler = bot.commandHandlers.get("bg")!;
      const ctx = { chat: { id: 12345 }, match: "research pricing", reply: mock(() => {}) };

      handler(ctx);
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.reply).toHaveBeenCalledWith('Background agent "research-pricing" started.');
      expect(config.runClaude).toHaveBeenCalledTimes(1);
    });

    it("/bg lists active background agents", async () => {
      const config = makeConfig({
        runClaude: mock(() => new Promise<ClaudeResult>(() => {})),
      });
      const app = createApp(config);
      const bot = app.bot as any;
      const bgHandler = bot.commandHandlers.get("bg")!;

      // Spawn via /bg command
      const spawnCtx = { chat: { id: 12345 }, match: "long task", reply: mock(() => {}) };
      bgHandler(spawnCtx);
      await new Promise((r) => setTimeout(r, 10));

      // List via /bg with no args
      const listCtx = { chat: { id: 12345 }, match: "", reply: mock(() => {}) };
      bgHandler(listCtx);

      const reply = (listCtx.reply as any).mock.calls[0][0];
      expect(reply).toContain("long-task");
      expect(reply).toMatch(/\d+s/);
    });
  });

  describe("error handler", () => {
    it("does not throw on bot errors", () => {
      const app = createApp(makeConfig());
      const bot = app.bot as any;

      expect(() => bot.errorHandler({ message: "connection lost" })).not.toThrow();
    });
  });

  describe("start", () => {
    it("starts the bot and logs info", () => {
      const app = createApp(makeConfig());
      expect(() => app.start()).not.toThrow();
    });

    it("registers commands with Telegram on start", () => {
      const app = createApp(makeConfig());
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

describe("requireEnv", () => {
  it("returns the env value when set", () => {
    process.env.TEST_VAR_MACROCLAW = "hello";
    expect(requireEnv("TEST_VAR_MACROCLAW")).toBe("hello");
    delete process.env.TEST_VAR_MACROCLAW;
  });

  it("exits when env var is missing", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    expect(() => requireEnv("NONEXISTENT_VAR_XYZ")).toThrow("exit");

    exitSpy.mockRestore();
  });
});
