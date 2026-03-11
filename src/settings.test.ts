import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings, type Settings, saveSettings } from "./settings";

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

describe("loadSettings", () => {
  it("returns null when file does not exist", () => {
    expect(loadSettings(tmpDir)).toBeNull();
  });

  it("reads and validates settings from file", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({
      botToken: "123:ABC",
      chatId: "12345678",
    }));
    const settings = loadSettings(tmpDir);
    expect(settings).toEqual({
      botToken: "123:ABC",
      chatId: "12345678",
      model: "sonnet",
      workspace: "~/.macroclaw-workspace",
      logLevel: "debug",
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
    const settings = loadSettings(tmpDir);
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
      loadSettings(tmpDir);
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
      loadSettings(tmpDir);
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
      loadSettings(tmpDir);
    } catch {
      // expected
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    process.exit = origExit;
  });
});

describe("saveSettings", () => {
  it("creates directory and writes file", () => {
    saveSettings(validSettings, tmpDir);
    const saved = loadSettings(tmpDir);
    expect(saved).toEqual(validSettings);
  });

  it("overwrites existing file", () => {
    saveSettings(validSettings, tmpDir);
    const updated = { ...validSettings, model: "opus" };
    saveSettings(updated, tmpDir);
    expect(loadSettings(tmpDir)).toEqual(updated);
  });
});
