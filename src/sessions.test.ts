import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearMainSession,
  getMainSession,
  loadSessions,
  newSessionId,
  saveSessions,
  setMainSession,
} from "./sessions";

const tmpDir = "/tmp/macroclaw-sessions-test";

function cleanup() {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
}

beforeEach(cleanup);
afterEach(cleanup);

describe("loadSessions", () => {
  it("returns empty sessions when dir does not exist", () => {
    expect(loadSessions(tmpDir)).toEqual({ mainSessions: {} });
  });

  it("returns empty sessions when file does not exist", () => {
    mkdirSync(tmpDir, { recursive: true });
    expect(loadSessions(tmpDir)).toEqual({ mainSessions: {} });
  });

  it("reads sessions from file", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "sessions.json"),
      JSON.stringify({ mainSessions: { admin: "abc-123", family: "def-456" } }),
    );
    expect(loadSessions(tmpDir)).toEqual({
      mainSessions: { admin: "abc-123", family: "def-456" },
    });
  });

  it("returns empty sessions when file is corrupt", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "sessions.json"), "not json");
    expect(loadSessions(tmpDir)).toEqual({ mainSessions: {} });
  });

  it("strips unknown fields via schema", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "sessions.json"),
      JSON.stringify({ mainSessions: { admin: "abc" }, extra: true }),
    );
    expect(loadSessions(tmpDir)).toEqual({ mainSessions: { admin: "abc" } });
  });

  it("migrates legacy mainSessionId to mainSessions.admin", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "sessions.json"), JSON.stringify({ mainSessionId: "legacy-id" }));
    expect(loadSessions(tmpDir)).toEqual({ mainSessions: { admin: "legacy-id" } });
  });

  it("defaults to empty mainSessions when field is missing", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "sessions.json"), JSON.stringify({}));
    expect(loadSessions(tmpDir)).toEqual({ mainSessions: {} });
  });
});

describe("saveSessions", () => {
  it("creates directory and writes file", () => {
    saveSessions({ mainSessions: { admin: "new-id" } }, tmpDir);
    expect(loadSessions(tmpDir)).toEqual({ mainSessions: { admin: "new-id" } });
  });

  it("overwrites existing file", () => {
    saveSessions({ mainSessions: { admin: "first" } }, tmpDir);
    saveSessions({ mainSessions: { admin: "second" } }, tmpDir);
    expect(loadSessions(tmpDir)).toEqual({ mainSessions: { admin: "second" } });
  });
});

describe("getMainSession / setMainSession / clearMainSession", () => {
  it("returns undefined when no session for chat", () => {
    expect(getMainSession("admin", tmpDir)).toBeUndefined();
  });

  it("returns stored session id", () => {
    saveSessions({ mainSessions: { admin: "abc", family: "def" } }, tmpDir);
    expect(getMainSession("admin", tmpDir)).toBe("abc");
    expect(getMainSession("family", tmpDir)).toBe("def");
  });

  it("setMainSession preserves other chats", () => {
    saveSessions({ mainSessions: { admin: "abc", family: "def" } }, tmpDir);
    setMainSession("admin", "new-admin-id", tmpDir);
    expect(loadSessions(tmpDir)).toEqual({
      mainSessions: { admin: "new-admin-id", family: "def" },
    });
  });

  it("setMainSession adds new chat without touching others", () => {
    saveSessions({ mainSessions: { admin: "abc" } }, tmpDir);
    setMainSession("work", "work-id", tmpDir);
    expect(loadSessions(tmpDir)).toEqual({
      mainSessions: { admin: "abc", work: "work-id" },
    });
  });

  it("clearMainSession removes one chat, preserves others", () => {
    saveSessions({ mainSessions: { admin: "abc", family: "def" } }, tmpDir);
    clearMainSession("family", tmpDir);
    expect(loadSessions(tmpDir)).toEqual({ mainSessions: { admin: "abc" } });
  });

  it("clearMainSession is a no-op when chat is not present", () => {
    saveSessions({ mainSessions: { admin: "abc" } }, tmpDir);
    clearMainSession("nobody", tmpDir);
    const contents = readFileSync(join(tmpDir, "sessions.json"), "utf-8");
    expect(JSON.parse(contents)).toEqual({ mainSessions: { admin: "abc" } });
  });
});

describe("newSessionId", () => {
  it("returns a valid UUID", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newSessionId()).not.toBe(id);
  });
});
