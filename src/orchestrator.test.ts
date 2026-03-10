import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { type ClaudeOptions, ClaudeParseError, ClaudeProcessError, type ClaudeResult, ClaudeTimeoutError } from "./claude";
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

function mockClaude(response: ClaudeResult | ((opts: ClaudeOptions) => Promise<ClaudeResult>)) {
  if (typeof response === "function") {
    return mock(response);
  }
  return mock(async () => response);
}

function successResult(structuredOutput: unknown): ClaudeResult {
  return { structuredOutput, duration: "1.0s", cost: "$0.05" };
}

describe("createOrchestrator", () => {
  describe("prompt building", () => {
    it("builds user prompt as-is", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "user", message: "hello" });

      const opts = claude.mock.calls[0][0];
      expect(opts.prompt).toBe("hello");
      expect(opts.systemPrompt).toContain("direct message from the user");
      expect(opts.timeoutMs).toBe(60_000);
    });

    it("prepends file references for user requests", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "user", message: "check this", files: ["/tmp/photo.jpg", "/tmp/doc.pdf"] });

      const opts = claude.mock.calls[0][0];
      expect(opts.prompt).toBe("[File: /tmp/photo.jpg]\n[File: /tmp/doc.pdf]\ncheck this");
    });

    it("sends only file references when message is empty", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "user", message: "", files: ["/tmp/photo.jpg"] });

      expect(claude.mock.calls[0][0].prompt).toBe("[File: /tmp/photo.jpg]");
    });

    it("builds cron prompt with prefix", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "cron", name: "daily", prompt: "check updates" });

      const opts = claude.mock.calls[0][0];
      expect(opts.prompt).toBe("[Tool: cron/daily] check updates");
      expect(opts.systemPrompt).toContain("cron event");
      expect(opts.timeoutMs).toBe(300_000);
    });

    it("uses cron model override", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, model: "sonnet", runClaude: claude });

      await orch.processRequest({ type: "cron", name: "smart", prompt: "think", model: "opus" });

      expect(claude.mock.calls[0][0].model).toBe("opus");
    });

    it("falls back to config model when cron has no model", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, model: "sonnet", runClaude: claude });

      await orch.processRequest({ type: "cron", name: "basic", prompt: "check" });

      expect(claude.mock.calls[0][0].model).toBe("sonnet");
    });

    it("builds background result prompt with prefix", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "background", name: "research", result: "found it" });

      const opts = claude.mock.calls[0][0];
      expect(opts.prompt).toBe("[Background: research] found it");
      expect(opts.systemPrompt).toContain("background agent you previously spawned");
      expect(opts.timeoutMs).toBe(60_000);
    });

    it("builds timeout retry prompt", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "timeout", originalMessage: "do something slow" });

      const opts = claude.mock.calls[0][0];
      expect(opts.prompt).toContain("[Timeout]");
      expect(opts.prompt).toContain("do something slow");
      expect(opts.timeoutMs).toBe(60_000);
    });

    it("builds bg-task with fresh session and bg timeout", async () => {
      saveSettings({ sessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "done", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "bg-task", name: "worker", prompt: "do work" });

      const opts = claude.mock.calls[0][0];
      expect(opts.prompt).toBe("do work");
      expect(opts.sessionFlag).toBe("--session-id");
      expect(opts.sessionId).not.toBe("main-session"); // fresh session
      expect(opts.systemPrompt).toContain('background agent named "worker"');
      expect(opts.timeoutMs).toBe(1_800_000);
    });

    it("uses bg-task model override", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "done", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, model: "sonnet", runClaude: claude });

      await orch.processRequest({ type: "bg-task", name: "fast", prompt: "quick check", model: "haiku" });

      expect(claude.mock.calls[0][0].model).toBe("haiku");
    });

    it("builds button click prompt", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "button", label: "Yes" });

      const opts = claude.mock.calls[0][0];
      expect(opts.prompt).toBe('The user clicked MessageButton: "Yes"');
      expect(opts.systemPrompt).toContain("tapped an inline keyboard button");
      expect(opts.timeoutMs).toBe(60_000);
    });
  });

  describe("schema validation", () => {
    it("validates and returns structured output", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "hello", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result).toEqual({ action: "send", message: "hello", actionReason: "ok" });
    });

    it("returns validation-failed for wrong shape", async () => {
      const claude = mockClaude(successResult({ action: "invalid", message: "hi", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.action).toBe("send");
      if (result.action === "send") expect(result.message).toBe("hi");
      expect(result.actionReason).toBe("validation-failed");
    });

    it("falls back to parsing result as JSON when structured_output is null", async () => {
      const jsonResult = JSON.stringify({ action: "send", message: "parsed", actionReason: "ok" });
      const claude = mockClaude({ structuredOutput: null, result: jsonResult });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.action).toBe("send");
      expect(result.message).toBe("parsed");
      expect(result.actionReason).toBe("ok");
    });

    it("forwards raw result text when structured_output is null and result is not JSON", async () => {
      const claude = mockClaude({ structuredOutput: null, result: "Claude said this" });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.actionReason).toBe("no-structured-output");
      expect(result.action).toBe("send");
      expect(result.message).toBe("Claude said this");
    });

    it("parses <StructuredOutput> XML when structured_output is null and result is XML", async () => {
      const xml = `<StructuredOutput>\n<parameter name="action">silent</parameter>\n<parameter name="actionReason">No notification needed</parameter>\n</StructuredOutput>`;
      const claude = mockClaude({ structuredOutput: null, result: xml });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.action).toBe("silent");
      expect(result.actionReason).toBe("No notification needed");
    });

    it("parses <StructuredOutput> XML with JSON array values", async () => {
      const xml = `<StructuredOutput>\n<parameter name="action">send</parameter>\n<parameter name="actionReason">reply</parameter>\n<parameter name="message">Hello</parameter>\n<parameter name="buttons">[[{"label":"Yes"},{"label":"No"}]]</parameter>\n</StructuredOutput>`;
      const claude = mockClaude({ structuredOutput: null, result: xml });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.action).toBe("send");
      expect(result.message).toBe("Hello");
      expect(result.buttons).toEqual([[{ label: "Yes" }, { label: "No" }]]);
    });

    it("returns [No output] when both structured_output and result are missing", async () => {
      const claude = mockClaude({ structuredOutput: null });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.actionReason).toBe("no-structured-output");
      expect(result.message).toBe("[No output]");
    });

    it("parses buttons from structured output", async () => {
      const output = {
        action: "send",
        message: "Choose",
        actionReason: "ok",
        buttons: [[{ label: "Yes" }, { label: "No" }], [{ label: "Maybe" }]],
      };
      const claude = mockClaude(successResult(output));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.buttons).toEqual([[{ label: "Yes" }, { label: "No" }], [{ label: "Maybe" }]]);
    });

    it("parses backgroundAgents from structured output", async () => {
      const output = {
        action: "send",
        message: "Starting",
        actionReason: "ok",
        backgroundAgents: [{ name: "research", prompt: "look into this", model: "haiku" }],
      };
      const claude = mockClaude(successResult(output));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.backgroundAgents).toEqual([{ name: "research", prompt: "look into this", model: "haiku" }]);
    });

    it("parses files from structured output", async () => {
      const output = { action: "send", message: "chart", actionReason: "ok", files: ["/tmp/chart.png"] };
      const claude = mockClaude(successResult(output));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.action === "send" && result.files).toEqual(["/tmp/chart.png"]);
    });
  });

  describe("error mapping", () => {
    it("maps ClaudeTimeoutError to timeout response", async () => {
      const claude = mock(async () => { throw new ClaudeTimeoutError(60_000); });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.action).toBe("send");
      if (result.action === "send") expect(result.message).toContain("timed out after 60s");
      expect(result.actionReason).toBe("timeout");
    });

    it("maps ClaudeProcessError to process-error response", async () => {
      const claude = mock(async () => { throw new ClaudeProcessError(1, "spawn failed"); });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.action).toBe("send");
      if (result.action === "send") {
        expect(result.message).toContain("[Error]");
        expect(result.message).toContain("spawn failed");
      }
      expect(result.actionReason).toBe("process-error");
    });

    it("maps ClaudeParseError to json-parse-failed response", async () => {
      const claude = mock(async () => { throw new ClaudeParseError("not json"); });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      const result = await orch.processRequest({ type: "user", message: "hi" });

      expect(result.action).toBe("send");
      if (result.action === "send") expect(result.message).toContain("[JSON Error]");
      expect(result.actionReason).toBe("json-parse-failed");
    });

    it("rethrows unknown errors", async () => {
      const claude = mock(async () => { throw new Error("unexpected"); });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await expect(orch.processRequest({ type: "user", message: "hi" })).rejects.toThrow("unexpected");
    });
  });

  describe("session management", () => {
    it("uses --resume for existing session", async () => {
      saveSettings({ sessionId: "existing-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "user", message: "hello" });

      expect(claude.mock.calls[0][0].sessionFlag).toBe("--resume");
      expect(claude.mock.calls[0][0].sessionId).toBe("existing-session");
    });

    it("creates new session when no settings exist", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "user", message: "hello" });

      expect(claude.mock.calls[0][0].sessionFlag).toBe("--session-id");
      expect(claude.mock.calls[0][0].sessionId).toMatch(/^[0-9a-f]{8}-/);
    });

    it("creates new session when resume fails", async () => {
      saveSettings({ sessionId: "old-session" }, tmpSettingsDir);
      let callCount = 0;
      const claude = mock(async (_opts: ClaudeOptions): Promise<ClaudeResult> => {
        callCount++;
        if (callCount === 1) throw new ClaudeProcessError(1, "session not found");
        return successResult({ action: "send", message: "ok", actionReason: "ok" });
      });
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "user", message: "hello" });

      expect(callCount).toBe(2);
      expect(claude.mock.calls[0][0].sessionFlag).toBe("--resume");
      expect(claude.mock.calls[1][0].sessionFlag).toBe("--session-id");
      expect(claude.mock.calls[1][0].sessionId).not.toBe("old-session");
    });

    it("switches to --resume after first success", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      await orch.processRequest({ type: "user", message: "first" });
      await orch.processRequest({ type: "user", message: "second" });

      expect(claude.mock.calls[0][0].sessionFlag).toBe("--session-id");
      expect(claude.mock.calls[1][0].sessionFlag).toBe("--resume");
    });

    it("exposes sessionId", () => {
      saveSettings({ sessionId: "test-id" }, tmpSettingsDir);
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: mock() as any });
      expect(orch.sessionId).toBe("test-id");
    });

    it("bg-task does not affect main session", async () => {
      saveSettings({ sessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = createOrchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, runClaude: claude });

      // First call: main session
      await orch.processRequest({ type: "user", message: "hello" });
      // bg-task: separate session
      await orch.processRequest({ type: "bg-task", name: "worker", prompt: "work" });
      // Third call: should still use main session
      await orch.processRequest({ type: "user", message: "again" });

      expect(claude.mock.calls[0][0].sessionId).toBe("main-session");
      expect(claude.mock.calls[1][0].sessionId).not.toBe("main-session"); // bg-task
      expect(claude.mock.calls[2][0].sessionId).toBe("main-session"); // main session preserved
    });
  });
});
