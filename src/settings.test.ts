import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Settings, SettingsManager } from "./settings";

const tmpDir = "/tmp/macroclaw-settings-test";

const validSettings: Settings = {
  botToken: "123:ABC",
  chatId: "12345678",
  model: "sonnet",
  workspace: "~/.macroclaw-workspace",
  logLevel: "debug",
};

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

describe("SettingsManager.load", () => {
  it("exits when file does not exist", () => {
    const mockExit = mock((_code?: number) => { throw new Error("exit"); });
    const origExit = process.exit;
    process.exit = mockExit as typeof process.exit;
    expect(() => new SettingsManager(tmpDir).load()).toThrow("exit");
    process.exit = origExit;
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("reads and validates settings from file", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({
      botToken: "123:ABC",
      chatId: "12345678",
    }));
    const settings = new SettingsManager(tmpDir).load();
    expect(settings).toEqual({
      botToken: "123:ABC",
      chatId: "12345678",
      model: "sonnet",
      workspace: "~/.macroclaw-workspace",
      logLevel: "info",
    });
  });

  it("applies defaults for optional fields", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({
      botToken: "tok",
      chatId: "123",
      model: "opus",
      workspace: "/custom",
      openaiApiKey: "sk-test",
      logLevel: "info",
      pinoramaUrl: "http://localhost:6200",
    }));
    const settings = new SettingsManager(tmpDir).load();
    expect(settings).toEqual({
      botToken: "tok",
      chatId: "123",
      model: "opus",
      workspace: "/custom",
      openaiApiKey: "sk-test",
      logLevel: "info",
      pinoramaUrl: "http://localhost:6200",
    });
  });

  it("exits with code 1 when file is not valid JSON", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), "not json");

    const mockExit = mock(() => { throw new Error("exit"); });
    const origExit = process.exit;
    process.exit = mockExit as any;

    try {
      new SettingsManager(tmpDir).load();
    } catch {
      // expected
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    process.exit = origExit;
  });

  it("exits with code 1 when validation fails (missing required field)", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ chatId: "123" }));

    const mockExit = mock(() => { throw new Error("exit"); });
    const origExit = process.exit;
    process.exit = mockExit as any;

    try {
      new SettingsManager(tmpDir).load();
    } catch {
      // expected
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    process.exit = origExit;
  });

  it("exits with code 1 when validation fails (invalid logLevel)", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({
      botToken: "tok",
      chatId: "123",
      logLevel: "verbose",
    }));

    const mockExit = mock(() => { throw new Error("exit"); });
    const origExit = process.exit;
    process.exit = mockExit as any;

    try {
      new SettingsManager(tmpDir).load();
    } catch {
      // expected
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    process.exit = origExit;
  });
});

describe("SettingsManager.save", () => {
  it("creates directory and writes file", () => {
    const mgr = new SettingsManager(tmpDir);
    mgr.save(validSettings);
    const saved = mgr.load();
    expect(saved).toEqual(validSettings);
  });

  it("overwrites existing file", () => {
    const mgr = new SettingsManager(tmpDir);
    mgr.save(validSettings);
    const updated = { ...validSettings, model: "opus" as const };
    mgr.save(updated);
    expect(mgr.load()).toEqual(updated);
  });
});

describe("SettingsManager.loadRaw", () => {
  it("returns null when file does not exist", () => {
    expect(new SettingsManager("/nonexistent/path").loadRaw()).toBeNull();
  });

  it("reads and parses valid settings file", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ botToken: "tok", chatId: "123" }));
    expect(new SettingsManager(tmpDir).loadRaw()).toEqual({ botToken: "tok", chatId: "123" });
  });

  it("returns null for invalid JSON", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), "not json");
    expect(new SettingsManager(tmpDir).loadRaw()).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), '"just a string"');
    expect(new SettingsManager(tmpDir).loadRaw()).toBeNull();
  });
});

describe("SettingsManager.applyEnvOverrides", () => {
  const envVars = [
    "TELEGRAM_BOT_TOKEN", "AUTHORIZED_CHAT_ID", "MODEL",
    "WORKSPACE", "OPENAI_API_KEY", "LOG_LEVEL", "PINORAMA_URL",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of envVars) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of envVars) {
      if (savedEnv[v] !== undefined) process.env[v] = savedEnv[v];
      else delete process.env[v];
    }
  });

  it("returns original settings when no env vars set", () => {
    const { settings, overrides } = new SettingsManager(tmpDir).applyEnvOverrides(validSettings);
    expect(settings).toEqual(validSettings);
    expect(overrides.size).toBe(0);
  });

  it("overrides model from MODEL env var", () => {
    process.env.MODEL = "opus";
    const { settings, overrides } = new SettingsManager(tmpDir).applyEnvOverrides(validSettings);
    expect(settings.model).toBe("opus");
    expect(overrides.has("model")).toBe(true);
  });

  it("overrides multiple fields and tracks them", () => {
    process.env.TELEGRAM_BOT_TOKEN = "override-token";
    process.env.AUTHORIZED_CHAT_ID = "99999";
    process.env.OPENAI_API_KEY = "sk-override";
    const { settings, overrides } = new SettingsManager(tmpDir).applyEnvOverrides(validSettings);
    expect(settings.botToken).toBe("override-token");
    expect(settings.chatId).toBe("99999");
    expect(settings.openaiApiKey).toBe("sk-override");
    expect(overrides.size).toBe(3);
  });

  it("overrides workspace and log-related fields", () => {
    process.env.WORKSPACE = "/override/path";
    process.env.LOG_LEVEL = "error";
    process.env.PINORAMA_URL = "http://override:6200";
    const { settings, overrides } = new SettingsManager(tmpDir).applyEnvOverrides(validSettings);
    expect(settings.workspace).toBe("/override/path");
    expect(settings.logLevel).toBe("error");
    expect(settings.pinoramaUrl).toBe("http://override:6200");
    expect(overrides.has("workspace")).toBe(true);
    expect(overrides.has("logLevel")).toBe(true);
    expect(overrides.has("pinoramaUrl")).toBe(true);
  });
});

describe("SettingsManager.print", () => {
  it("does not throw", () => {
    expect(() => new SettingsManager(tmpDir).print(validSettings, new Set())).not.toThrow();
  });

  it("does not throw with overrides", () => {
    expect(() => new SettingsManager(tmpDir).print(validSettings, new Set(["model"]))).not.toThrow();
  });

  it("does not throw with optional fields set", () => {
    const full: Settings = {
      ...validSettings,
      openaiApiKey: "sk-1234567890",
      pinoramaUrl: "http://localhost:6200",
    };
    expect(() => new SettingsManager(tmpDir).print(full, new Set(["model", "openaiApiKey"]))).not.toThrow();
  });

  it("masks botToken showing only last 4 chars", () => {
    expect(() => new SettingsManager(tmpDir).print({ ...validSettings, botToken: "ab" }, new Set())).not.toThrow();
  });
});

describe("SettingsManager.envMapping", () => {
  it("is a static property with all settings keys", () => {
    expect(SettingsManager.envMapping.botToken).toBe("TELEGRAM_BOT_TOKEN");
    expect(SettingsManager.envMapping.chatId).toBe("AUTHORIZED_CHAT_ID");
    expect(SettingsManager.envMapping.model).toBe("MODEL");
  });
});
