import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { ClaudeResponse } from "./claude";
import { createOrchestrator } from "./orchestrator";
import { saveSettings } from "./settings";

const tmpSettingsDir = "/tmp/macroclaw-test-orchestrator-settings";
const TEST_WORKSPACE = "/tmp/macroclaw-test-workspace";

beforeEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

function mockClaude(response: ClaudeResponse | ((...args: any[]) => Promise<ClaudeResponse>)) {
  if (typeof response === "function") {
    return mock(response);
  }
  return mock(async () => response);
}

describe("createOrchestrator", () => {
  describe("prompt building", () => {
    it("builds user prompt as-is", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "user", message: "hello" });

      const call = claude.mock.calls[0];
      expect(call[0]).toBe("hello");
      expect(call[5]).toContain("direct message from the user");
      expect(call[6]).toBe(60_000);
    });

    it("passes files for user requests", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "user", message: "check this", files: ["/tmp/photo.jpg"] });

      const call = claude.mock.calls[0];
      expect(call[7]).toEqual(["/tmp/photo.jpg"]);
    });

    it("builds cron prompt with prefix", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "cron", name: "daily", prompt: "check updates" });

      const call = claude.mock.calls[0];
      expect(call[0]).toBe("[Tool: cron/daily] check updates");
      expect(call[5]).toContain("cron event");
      expect(call[6]).toBe(300_000);
    });

    it("uses cron model override", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, model: "sonnet", runClaude: claude as any });

      await orch.processRequest({ type: "cron", name: "smart", prompt: "think", model: "opus" });

      expect(claude.mock.calls[0][3]).toBe("opus");
    });

    it("falls back to config model when cron has no model", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, model: "sonnet", runClaude: claude as any });

      await orch.processRequest({ type: "cron", name: "basic", prompt: "check" });

      expect(claude.mock.calls[0][3]).toBe("sonnet");
    });

    it("builds background result prompt with prefix", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "background", name: "research", result: "found it" });

      const call = claude.mock.calls[0];
      expect(call[0]).toBe("[Background: research] found it");
      expect(call[5]).toContain("background agent you previously spawned");
      expect(call[6]).toBe(60_000);
    });

    it("builds timeout retry prompt", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "timeout", originalMessage: "do something slow" });

      const call = claude.mock.calls[0];
      expect(call[0]).toContain("[Timeout]");
      expect(call[0]).toContain("do something slow");
      expect(call[5]).toContain("direct message from the user");
      expect(call[6]).toBe(60_000);
    });

    it("builds bg-task with fresh session and bg timeout", async () => {
      saveSettings({ sessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "done", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "bg-task", name: "worker", prompt: "do work" });

      const call = claude.mock.calls[0];
      expect(call[0]).toBe("do work");
      expect(call[1]).toBe("--session-id");
      expect(call[2]).not.toBe("main-session"); // fresh session
      expect(call[5]).toContain('background agent named "worker"');
      expect(call[6]).toBe(1_800_000);
    });

    it("uses bg-task model override", async () => {
      const claude = mockClaude({ action: "send", message: "done", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, model: "sonnet", runClaude: claude as any });

      await orch.processRequest({ type: "bg-task", name: "fast", prompt: "quick check", model: "haiku" });

      expect(claude.mock.calls[0][3]).toBe("haiku");
    });
  });

  describe("session management", () => {
    it("uses --resume for existing session", async () => {
      saveSettings({ sessionId: "existing-session" }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "user", message: "hello" });

      expect(claude.mock.calls[0][1]).toBe("--resume");
      expect(claude.mock.calls[0][2]).toBe("existing-session");
    });

    it("creates new session when no settings exist", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "user", message: "hello" });

      expect(claude.mock.calls[0][1]).toBe("--session-id");
      expect(claude.mock.calls[0][2]).toMatch(/^[0-9a-f]{8}-/);
    });

    it("creates new session when resume fails", async () => {
      saveSettings({ sessionId: "old-session" }, tmpSettingsDir);
      let callCount = 0;
      const claude = mockClaude(async (): Promise<ClaudeResponse> => {
        callCount++;
        if (callCount === 1) return { action: "send", message: "[Error]", actionReason: "process-error" };
        return { action: "send", message: "ok", actionReason: "ok" };
      });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "user", message: "hello" });

      expect(callCount).toBe(2);
      expect(claude.mock.calls[0][1]).toBe("--resume");
      expect(claude.mock.calls[1][1]).toBe("--session-id");
      expect(claude.mock.calls[1][2]).not.toBe("old-session");
    });

    it("switches to --resume after first success", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      await orch.processRequest({ type: "user", message: "first" });
      await orch.processRequest({ type: "user", message: "second" });

      expect(claude.mock.calls[0][1]).toBe("--session-id");
      expect(claude.mock.calls[1][1]).toBe("--resume");
    });

    it("exposes sessionId", () => {
      saveSettings({ sessionId: "test-id" }, tmpSettingsDir);
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: mock() as any });
      expect(orch.sessionId).toBe("test-id");
    });

    it("bg-task does not affect main session", async () => {
      saveSettings({ sessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude as any });

      // First call: main session
      await orch.processRequest({ type: "user", message: "hello" });
      // bg-task: separate session
      await orch.processRequest({ type: "bg-task", name: "worker", prompt: "work" });
      // Third call: should still use main session
      await orch.processRequest({ type: "user", message: "again" });

      expect(claude.mock.calls[0][2]).toBe("main-session");
      expect(claude.mock.calls[1][2]).not.toBe("main-session"); // bg-task
      expect(claude.mock.calls[2][2]).toBe("main-session"); // main session preserved
    });
  });
});
