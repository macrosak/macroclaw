import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SetupIo } from "./setup";

// Mock child_process so resolveClaudePath doesn't hit real `which`
const mockExecSync = mock((_cmd: string, _opts?: object) => "/mock/bin/claude\n");
mock.module("node:child_process", () => ({
  execSync: mockExecSync,
}));

// Mock Grammy Bot
const mockBotInit = mock(async () => {});
const mockBotStart = mock(async () => {});
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

    async start() {
      await mockBotStart();
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

const { SetupWizard } = await import("./setup");

async function runSetup(io: SetupIo, opts?: ConstructorParameters<typeof SetupWizard>[1]) {
  const wizard = new SetupWizard(io, opts);
  const settings = await wizard.collectSettings();
  await wizard.installService();
  return settings;
}

function createMockIO(inputs: string[]): SetupIo & { written: string[] } {
  let index = 0;
  const written: string[] = [];
  const io = {
    open: () => {},
    close: () => {},
    ask: async () => inputs[index++] ?? "",
    write: (msg: string) => { written.push(msg); },
    written,
  };
  return io;
}

// Save/restore env vars
const envVars = ["TELEGRAM_BOT_TOKEN", "AUTHORIZED_CHAT_ID", "MODEL", "WORKSPACE", "TIMEZONE", "OPENAI_API_KEY", "LOG_LEVEL"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of envVars) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
  mockExecSync.mockImplementation((_cmd: string, _opts?: object) => "/mock/bin/claude\n");
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

describe("SetupWizard", () => {
  it("collects all required fields via prompts", async () => {
    const io = createMockIO([
      "123:ABC",        // bot token
      "12345678",       // chat ID
      "opus",           // model
      "/my/ws",         // workspace
      "Europe/Prague",  // timezone
      "sk-test",        // openai key
      "",               // no service install
    ]);

    const settings = await runSetup(io);

    expect(settings.botToken).toBe("123:ABC");
    expect(settings.chatId).toBe("12345678");
    expect(settings.model).toBe("opus");
    expect(settings.workspace).toBe("/my/ws");
    expect(settings.timeZone).toBe("Europe/Prague");
    expect(settings.openaiApiKey).toBe("sk-test");
    expect(settings.logLevel).toBe("info");
  });

  it("uses defaults from env vars when user presses enter", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-token";
    process.env.AUTHORIZED_CHAT_ID = "99887766";
    process.env.MODEL = "haiku";
    process.env.WORKSPACE = "/env/ws";
    process.env.TIMEZONE = "America/New_York";
    process.env.OPENAI_API_KEY = "sk-env";

    const io = createMockIO([
      "",  // accept default token
      "",  // accept default chat ID
      "",  // accept default model
      "",  // accept default workspace
      "",  // accept default timezone
      "",  // accept default openai key
      "",  // no service install
    ]);

    const settings = await runSetup(io);

    expect(settings.botToken).toBe("env-token");
    expect(settings.chatId).toBe("99887766");
    expect(settings.model).toBe("haiku");
    expect(settings.workspace).toBe("/env/ws");
    expect(settings.timeZone).toBe("America/New_York");
    expect(settings.openaiApiKey).toBe("sk-env");
  });

  it("uses sonnet as default model when no env var", async () => {
    const io = createMockIO([
      "tok",
      "123",
      "",       // press enter for default model
      "",       // press enter for default workspace
      "",       // press enter for default timezone
      "",       // press enter for no openai key
      "",       // no service install
    ]);

    const settings = await runSetup(io);

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
      "",  // timezone
      "",
      "",  // no service install
    ]);

    await runSetup(io);

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
      "",  // timezone
      "",
      "",
      "",  // no service install
    ]);

    const settings = await runSetup(io);

    expect(settings.botToken).toBe("good-token");
    expect(callCount).toBe(2);
  });

  it("re-prompts when bot token is empty", async () => {
    const io = createMockIO([
      "",            // empty — re-prompt
      "actual-token",
      "123",
      "",
      "",  // timezone
      "",
      "",
      "",  // no service install
    ]);

    const settings = await runSetup(io);

    expect(settings.botToken).toBe("actual-token");
  });

  it("re-prompts when chat ID is empty", async () => {
    const io = createMockIO([
      "tok",
      "",        // empty — re-prompt
      "456",
      "",
      "",  // timezone
      "",
      "",
      "",  // no service install
    ]);

    const settings = await runSetup(io);

    expect(settings.chatId).toBe("456");
  });

  it("re-prompts when chat ID is not numeric", async () => {
    const io = createMockIO([
      "tok",
      "not-a-number",  // invalid — re-prompt
      "456",
      "",
      "",  // timezone
      "",
      "",
      "",  // no service install
    ]);

    const settings = await runSetup(io);

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
      "",  // timezone
      "",
      "",  // no service install
    ]);

    const settings = await runSetup(io);

    expect(settings.model).toBe("opus");
    expect(io.written).toContainEqual(expect.stringContaining("Invalid value"));
  });

  it("registers and uses catch handler on setup bot", async () => {
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",  // timezone
      "",
      "",  // no service install
    ]);

    await runSetup(io);

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
      "",  // timezone
      "",
      "",  // no service install
    ]);

    await runSetup(io);

    expect(mockBotCommandHandler).not.toBeNull();
    const mockReply = mock(() => {});
    mockBotCommandHandler!({ chat: { id: 12345 }, reply: mockReply });
    expect(mockReply).toHaveBeenCalledWith("12345");
  });

it("installs service when user answers yes", async () => {
    mockInstall.mockClear();
    const installer = createMockServiceInstaller();
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",  // timezone
      "",
      "y",
      "sk-test-token",  // oauth token (macOS)
    ]);

    await runSetup(io, { serviceInstaller: installer, platform: "darwin" });

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
      "",  // timezone
      "",
      "n",  // no to service install
    ]);

    await runSetup(io, { serviceInstaller: installer });

    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("skips service install when oauth token is empty on macOS", async () => {
    mockInstall.mockClear();
    const installer = createMockServiceInstaller();
    const io = createMockIO([
      "tok",
      "123",
      "",
      "",
      "",  // timezone
      "",
      "y",
      "",  // empty oauth token
    ]);

    const settings = await runSetup(io, { serviceInstaller: installer, platform: "darwin" });

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
      "",  // timezone
      "",
      "yes",
      "sk-test-token",  // oauth token (macOS)
    ]);

    await runSetup(io, { serviceInstaller: installer, platform: "darwin" });

    expect(io.written).toContainEqual(expect.stringContaining("Service installation failed: Permission denied"));
  });

  it("forceInstallService installs without prompting", async () => {
    mockInstall.mockClear();
    const installer = createMockServiceInstaller();
    const io = createMockIO([
      "sk-test-token",  // oauth token (macOS)
    ]);

    const wizard = new SetupWizard(io, { serviceInstaller: installer, platform: "darwin" });
    await wizard.forceInstallService();

    expect(mockInstall).toHaveBeenCalled();
    expect(io.written).toContainEqual(expect.stringContaining("Service installed and started."));
  });

  it("forceInstallService skips on Linux without prompting", async () => {
    mockInstall.mockClear();
    const installer = createMockServiceInstaller();
    const io = createMockIO([]);

    const wizard = new SetupWizard(io, { serviceInstaller: installer, platform: "linux" });
    await wizard.forceInstallService();

    expect(mockInstall).toHaveBeenCalled();
  });

  it("fails fast when claude CLI is not found", async () => {
    mockExecSync.mockImplementation(() => { throw new Error("not found"); });
    const io = createMockIO([]);
    await expect(
      runSetup(io),
    ).rejects.toThrow("Claude Code CLI not found.");
  });

});
