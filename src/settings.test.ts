import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSettings, newSessionId, saveSettings } from "./settings";

const tmpDir = "/tmp/macroclaw-settings-test";

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

describe("loadSettings", () => {
  it("returns empty object when dir does not exist", () => {
    expect(loadSettings(tmpDir)).toEqual({});
  });

  it("returns empty object when file does not exist", () => {
    mkdirSync(tmpDir, { recursive: true });
    expect(loadSettings(tmpDir)).toEqual({});
  });

  it("reads settings from file", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify({ sessionId: "abc-123" }));
    expect(loadSettings(tmpDir)).toEqual({ sessionId: "abc-123" });
  });

  it("returns empty object when file is corrupt", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "settings.json"), "not json");
    expect(loadSettings(tmpDir)).toEqual({});
  });
});

describe("saveSettings", () => {
  it("creates directory and writes file", () => {
    saveSettings({ sessionId: "new-id" }, tmpDir);
    const saved = loadSettings(tmpDir);
    expect(saved).toEqual({ sessionId: "new-id" });
  });

  it("overwrites existing file", () => {
    saveSettings({ sessionId: "first" }, tmpDir);
    saveSettings({ sessionId: "second" }, tmpDir);
    expect(loadSettings(tmpDir)).toEqual({ sessionId: "second" });
  });
});

describe("newSessionId", () => {
  it("returns a valid UUID", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newSessionId()).not.toBe(id);
  });
});
