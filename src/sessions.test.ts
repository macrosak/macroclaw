import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSessions, newSessionId, saveSessions } from "./sessions";

const tmpDir = "/tmp/macroclaw-sessions-test";

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

describe("loadSessions", () => {
  it("returns empty object when dir does not exist", () => {
    expect(loadSessions(tmpDir)).toEqual({});
  });

  it("returns empty object when file does not exist", () => {
    mkdirSync(tmpDir, { recursive: true });
    expect(loadSessions(tmpDir)).toEqual({});
  });

  it("reads sessions from file", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "sessions.json"), JSON.stringify({ mainSessionId: "abc-123" }));
    expect(loadSessions(tmpDir)).toEqual({ mainSessionId: "abc-123" });
  });

  it("returns empty object when file is corrupt", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "sessions.json"), "not json");
    expect(loadSessions(tmpDir)).toEqual({});
  });

  it("strips unknown fields via schema", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "sessions.json"), JSON.stringify({ mainSessionId: "abc", extra: true }));
    const result = loadSessions(tmpDir);
    expect(result).toEqual({ mainSessionId: "abc" });
  });
});

describe("saveSessions", () => {
  it("creates directory and writes file", () => {
    saveSessions({ mainSessionId: "new-id" }, tmpDir);
    const saved = loadSessions(tmpDir);
    expect(saved).toEqual({ mainSessionId: "new-id" });
  });

  it("overwrites existing file", () => {
    saveSessions({ mainSessionId: "first" }, tmpDir);
    saveSessions({ mainSessionId: "second" }, tmpDir);
    expect(loadSessions(tmpDir)).toEqual({ mainSessionId: "second" });
  });
});

describe("newSessionId", () => {
  it("returns a valid UUID", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newSessionId()).not.toBe(id);
  });
});
