import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SetupIO } from "./setup";

// Mock child_process so resolveClaudePath doesn't hit real `which`
mock.module("node:child_process", () => ({
  execSync: (_cmd: string) => "/mock/bin/claude\n",
}));

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

const mockInstall = mock(() => "tail -f /mock/logs");

function createMockServiceInstaller() {
  return {
    install: mockInstall,
  };
}

const { resolveClaudePath, runSetupWizard } = await import("./setup");

function createMockIO(inputs: string[]): SetupIO & { written: string[]; closed: boolean } {
  let index = 0;
  const written: string[] = [];
  const io = {
    ask: async () => inputs[index++] ?? "",
    write: (msg: string) => { written.push(msg); },
    close: () => { io.closed = true; },
    written,
    closed: false,
  };
  return io;
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
  mockInstall.mockImplementation(() => "tail -f /mock/logs");
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
      "",          // no service install
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
    process.env.AUTHORIZED_CHAT_ID = "99887766";
    process.env.MODEL = "haiku";
    process.env.WORKSPACE = "/env/ws";
    process.env.OPENAI_API_KEY = "sk-env";

    const io = createMockIO([
      "",  // accept default token
      "",  // accept default chat ID
      "",  // accept default model
      "",  // accept default workspace
      "",  // accept default openai key
      "",  // no service install
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.botToken).toBe("env-token");
    expect(settings.chatId).toBe("99887766");
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
      "",       // no service install
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
      "",  // no service install
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
      "",  // no service install
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
      "",  // no service install
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
      "",  // no service install
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.chatId).toBe("456");
  });

  it("re-prompts when chat ID is not numeric", async () => {
    const io = createMockIO([
      "tok",
      "not-a-number",  // invalid — re-prompt
      "456",
      "",
      "",
      "",
      "",  // no service install
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.chatId).toBe("456");
    expect(io.written).toContainEqual(expect.stringContaining("Invalid value"));
  });

  it("re-prompts when model is invalid", async () => {
    const io = createMockIO([
      "tok",
      "123",
      "xxx",     // invalid — re-prompt
      "opus",    // valid
      "",
      "",
      "",  // no service install
    ]);

    const settings = await runSetupWizard(io);

    expect(settings.model).toBe("opus");
    expect(io.written).toContainEqual(expect.stringContaining("Invalid value"));
  });

  it("registers and uses catch handler on setup bot", async () => {
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
      "",  // no service install
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
      "",  // no service install
    ]);

    await runSetupWizard(io);

    expect(mockBotCommandHandler).not.toBeNull();
    const mockReply = mock(() => {});
    mockBotCommandHandler!({ chat: { id: 12345 }, reply: mockReply });
    expect(mockReply).toHaveBeenCalledWith("12345");
  });

  it("calls onSettingsReady before service install prompt", async () => {
    const order: string[] = [];
    const installer = { install: () => { order.push("install"); return ""; } };
    const onSettingsReady = () => { order.push("save"); };
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
      "y",
      "sk-test-token",  // oauth token (macOS)
    ]);

    await runSetupWizard(io, { serviceInstaller: installer, onSettingsReady, platform: "darwin" });

    expect(order).toEqual(["save", "install"]);
  });

  it("closes io before running service install", async () => {
    let closedBeforeInstall = false;
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
      "y",
      "sk-test-token",  // oauth token (macOS)
    ]);
    const installer = { install: () => { closedBeforeInstall = io.closed; return ""; } };

    await runSetupWizard(io, { serviceInstaller: installer, platform: "darwin" });

    expect(closedBeforeInstall).toBe(true);
  });

  it("installs service when user answers yes", async () => {
    mockInstall.mockClear();
    const installer = createMockServiceInstaller();
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
      "y",
      "sk-test-token",  // oauth token (macOS)
    ]);

    await runSetupWizard(io, { serviceInstaller: installer, platform: "darwin" });

    expect(mockInstall).toHaveBeenCalled();
    expect(io.written).toContainEqual(expect.stringContaining("Service installed and started."));
  });

  it("skips service install when user answers no", async () => {
    mockInstall.mockClear();
    const installer = createMockServiceInstaller();
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
      "n",  // no to service install
    ]);

    await runSetupWizard(io, { serviceInstaller: installer });

    expect(mockInstall).not.toHaveBeenCalled();
    expect(io.closed).toBe(true);
  });

  it("skips service install when oauth token is empty on macOS", async () => {
    mockInstall.mockClear();
    const installer = createMockServiceInstaller();
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
      "y",
      "",  // empty oauth token
    ]);

    const settings = await runSetupWizard(io, { serviceInstaller: installer, platform: "darwin" });

    expect(mockInstall).not.toHaveBeenCalled();
    expect(io.written).toContainEqual(expect.stringContaining("No token provided"));
    expect(settings.botToken).toBe("tok");
  });

  it("handles service install failure gracefully", async () => {
    mockInstall.mockImplementation(() => { throw new Error("Permission denied"); });
    const installer = createMockServiceInstaller();
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",
      "yes",
      "sk-test-token",  // oauth token (macOS)
    ]);

    await runSetupWizard(io, { serviceInstaller: installer, platform: "darwin" });

    expect(io.written).toContainEqual(expect.stringContaining("Service installation failed: Permission denied"));
  });

  it("fails fast when claude CLI is not found", async () => {
    const io = createMockIO([]);
    await expect(
      runSetupWizard(io, { resolveClaude: () => { throw new Error("Claude Code CLI not found."); } }),
    ).rejects.toThrow("Claude Code CLI not found.");
  });

  it("resolveClaudePath returns trimmed path on success", () => {
    const result = resolveClaudePath(() => "/usr/local/bin/claude\n");
    expect(result).toBe("/usr/local/bin/claude");
  });

  it("resolveClaudePath throws when claude is not found", () => {
    expect(() => resolveClaudePath(() => { throw new Error("not found"); })).toThrow(
      "Claude Code CLI not found.",
    );
  });
});
