import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SetupIO } from "./setup";

// Mock Grammy Bot
const mockBotInit = mock(async () => {});
const mockBotStart = mock(() => {});
const mockBotStop = mock(async () => {});
const mockSetMyCommands = mock(async () => {});
let mockBotCatchHandler: Function | null = null;
let mockBotCommandHandler: Function | null = null;

mock.module("grammy", () => ({
  Bot: class MockBot {
    token: string;
    botInfo = { username: "test_bot" };

    api = { setMyCommands: mockSetMyCommands };

    constructor(token: string) {
      this.token = token;
    }

    command(_name: string, handler: Function) {
      mockBotCommandHandler = handler;
    }

    catch(handler: Function) {
      mockBotCatchHandler = handler;
    }

    async init() {
      await mockBotInit();
    }

    start() {
      mockBotStart();
    }

    async stop() {
      await mockBotStop();
    }
  },
}));

const { runSetupWizard } = await import("./setup");

function createMockIO(inputs: string[]): SetupIO {
  let index = 0;
  const written: string[] = [];
  return {
    ask: async () => inputs[index++] ?? "",
    write: (msg: string) => { written.push(msg); },
  };
}

// Save/restore env vars
const envVars = ["TELEGRAM_BOT_TOKEN", "AUTHORIZED_CHAT_ID", "MODEL", "WORKSPACE", "OPENAI_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of envVars) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
  mockBotInit.mockImplementation(async () => {});
  mockBotStart.mockClear();
  mockBotStop.mockClear();
  mockSetMyCommands.mockClear();
  mockBotCatchHandler = null;
  mockBotCommandHandler = null;
});

afterEach(() => {
  for (const v of envVars) {
    if (savedEnv[v] !== undefined) process.env[v] = savedEnv[v];
    else delete process.env[v];
  }
});

describe("runSetupWizard", () => {
  it("collects all required fields via prompts", async () => {
    const io = createMockIO([
      "123:ABC",   // bot token
      "12345678",  // chat ID
      "opus",      // model
      "/my/ws",    // workspace
      "sk-test",   // openai key
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.botToken).toBe("123:ABC");
    expect(settings.chatId).toBe("12345678");
    expect(settings.model).toBe("opus");
    expect(settings.workspace).toBe("/my/ws");
    expect(settings.openaiApiKey).toBe("sk-test");
    expect(settings.logLevel).toBe("debug");
  });

  it("uses defaults from env vars when user presses enter", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-token";
    process.env.AUTHORIZED_CHAT_ID = "env-chat";
    process.env.MODEL = "haiku";
    process.env.WORKSPACE = "/env/ws";
    process.env.OPENAI_API_KEY = "sk-env";

    const io = createMockIO([
      "",  // accept default token
      "",  // accept default chat ID
      "",  // accept default model
      "",  // accept default workspace
      "",  // accept default openai key
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.botToken).toBe("env-token");
    expect(settings.chatId).toBe("env-chat");
    expect(settings.model).toBe("haiku");
    expect(settings.workspace).toBe("/env/ws");
    expect(settings.openaiApiKey).toBe("sk-env");
  });

  it("uses sonnet as default model when no env var", async () => {
    const io = createMockIO([
      "tok",
      "123",
      "",       // press enter for default model
      "",       // press enter for default workspace
      "",       // press enter for no openai key
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.model).toBe("sonnet");
    expect(settings.workspace).toBe("~/.macroclaw-workspace");
    expect(settings.openaiApiKey).toBeUndefined();
  });

  it("starts and stops the setup bot", async () => {
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
    ]);

    await runSetupWizard(io);

    expect(mockBotInit).toHaveBeenCalled();
    expect(mockBotStart).toHaveBeenCalled();
    expect(mockBotStop).toHaveBeenCalled();
  });

  it("re-prompts on invalid bot token", async () => {
    let callCount = 0;
    mockBotInit.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Invalid token");
    });

    const io = createMockIO([
      "bad-token",   // first attempt — fails
      "good-token",  // second attempt — succeeds
      "123",
      "",
      "",
      "",
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.botToken).toBe("good-token");
    expect(callCount).toBe(2);
  });

  it("re-prompts when bot token is empty", async () => {
    const io = createMockIO([
      "",            // empty — re-prompt
      "actual-token",
      "123",
      "",
      "",
      "",
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.botToken).toBe("actual-token");
  });

  it("re-prompts when chat ID is empty", async () => {
    const io = createMockIO([
      "tok",
      "",        // empty — re-prompt
      "456",
      "",
      "",
      "",
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.chatId).toBe("456");
  });

  it("registers and uses catch handler on setup bot", async () => {
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
    ]);

    await runSetupWizard(io);

    // The catch handler was registered
    expect(mockBotCatchHandler).not.toBeNull();
    // Calling it should not throw (it logs internally)
    expect(() => mockBotCatchHandler!(new Error("test error"))).not.toThrow();
  });

  it("registers /chatid command handler on setup bot", async () => {
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
    ]);

    await runSetupWizard(io);

    expect(mockBotCommandHandler).not.toBeNull();
    const mockReply = mock(() => {});
    mockBotCommandHandler!({ chat: { id: 12345 }, reply: mockReply });
    expect(mockReply).toHaveBeenCalledWith("12345");
  });
});
