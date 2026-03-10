import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { type Claude, ClaudeParseError, ClaudeProcessError, type ClaudeResult, type ClaudeRunOptions, isDeferred } from "./claude";
import { type ClaudeResponse, Orchestrator } from "./orchestrator";
import { saveSettings } from "./settings";

async function processSync(orch: Orchestrator, ...args: Parameters<Orchestrator["processRequest"]>): Promise<ClaudeResponse> {
  const result = await orch.processRequest(...args);
  if (isDeferred(result)) throw new Error("Expected sync result, got deferred");
  return result;
}

const tmpSettingsDir = "/tmp/macroclaw-test-orchestrator-settings";
const TEST_WORKSPACE = "/tmp/macroclaw-test-workspace";

beforeEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

function mockClaude(response: ClaudeResult | ((opts: ClaudeRunOptions) => Promise<ClaudeResult>)) {
  const run = typeof response === "function"
    ? mock(response)
    : mock(async () => response);
  return { run } as unknown as Claude & { run: ReturnType<typeof mock> };
}

function successResult(structuredOutput: unknown, sessionId = "test-session-id"): ClaudeResult {
  return { structuredOutput, sessionId, duration: "1.0s", cost: "$0.05" };
}

describe("Orchestrator", () => {
  describe("prompt building", () => {
    it("builds user prompt as-is", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "hello" });

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe("hello");
      expect(opts.systemPrompt).toContain("direct message from the user");
      expect(opts.timeoutMs).toBe(60_000);
    });

    it("prepends file references for user requests", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "check this", files: ["/tmp/photo.jpg", "/tmp/doc.pdf"] });

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe("[File: /tmp/photo.jpg]\n[File: /tmp/doc.pdf]\ncheck this");
    });

    it("sends only file references when message is empty", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "", files: ["/tmp/photo.jpg"] });

      expect(claude.run.mock.calls[0][0].prompt).toBe("[File: /tmp/photo.jpg]");
    });

    it("builds cron prompt with prefix", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "cron", name: "daily", prompt: "check updates" });

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe("[Tool: cron/daily] check updates");
      expect(opts.systemPrompt).toContain("cron event");
      expect(opts.timeoutMs).toBe(300_000);
    });

    it("uses cron model override", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, model: "sonnet", claude });

      await processSync(orch, { type: "cron", name: "smart", prompt: "think", model: "opus" });

      expect(claude.run.mock.calls[0][0].model).toBe("opus");
    });

    it("falls back to config model when cron has no model", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, model: "sonnet", claude });

      await processSync(orch, { type: "cron", name: "basic", prompt: "check" });

      expect(claude.run.mock.calls[0][0].model).toBe("sonnet");
    });

    it("builds background result prompt with prefix", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "background-agent-result", name: "research", result: "found it" });

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe("[Background: research] found it");
      expect(opts.systemPrompt).toContain("background agent you previously spawned");
      expect(opts.timeoutMs).toBe(60_000);
    });

    it("builds background-agent with forked session and bg timeout", async () => {
      saveSettings({ sessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "done", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "background-agent", name: "worker", prompt: "do work" });

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe("do work");
      expect(opts.sessionFlag).toBe("--resume");
      expect(opts.sessionId).toBe("main-session");
      expect(opts.forkSession).toBe(true);
      expect(opts.systemPrompt).toContain('background agent named "worker"');
      expect(opts.timeoutMs).toBe(1_800_000);
    });

    it("uses background-agent model override", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "done", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, model: "sonnet", claude });

      await processSync(orch, { type: "background-agent", name: "fast", prompt: "quick check", model: "haiku" });

      expect(claude.run.mock.calls[0][0].model).toBe("haiku");
    });

    it("builds button click prompt", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "button", label: "Yes" });

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe('The user clicked MessageButton: "Yes"');
      expect(opts.systemPrompt).toContain("tapped an inline keyboard button");
      expect(opts.timeoutMs).toBe(60_000);
    });
  });

  describe("schema validation", () => {
    it("validates and returns structured output", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "hello", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

      expect(result).toEqual({ action: "send", message: "hello", actionReason: "ok" });
    });

    it("returns validation-failed for wrong shape", async () => {
      const claude = mockClaude(successResult({ action: "invalid", message: "hi", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

      expect(result.action).toBe("send");
      if (result.action === "send") expect(result.message).toBe("hi");
      expect(result.actionReason).toBe("validation-failed");
    });

    it("sends result with prefix when structured_output is missing", async () => {
      const claude = mockClaude({ structuredOutput: null, sessionId: "s1", result: "Claude said this" });
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

      expect(result.actionReason).toBe("no-structured-output");
      expect(result.action).toBe("send");
      expect(result.message).toBe("[No structured output] Claude said this");
    });

    it("escapes HTML in fallback result to prevent Telegram parse errors", async () => {
      const claude = mockClaude({ structuredOutput: null, sessionId: "s1", result: "<b>bold</b> & stuff" });
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

      expect(result.message).toBe("[No structured output] &lt;b&gt;bold&lt;/b&gt; &amp; stuff");
    });

    it("returns [No output] when both structured_output and result are missing", async () => {
      const claude = mockClaude({ structuredOutput: null, sessionId: "s1" });
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

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
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

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
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

      expect(result.backgroundAgents).toEqual([{ name: "research", prompt: "look into this", model: "haiku" }]);
    });

    it("parses files from structured output", async () => {
      const output = { action: "send", message: "chart", actionReason: "ok", files: ["/tmp/chart.png"] };
      const claude = mockClaude(successResult(output));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

      expect(result.action === "send" && result.files).toEqual(["/tmp/chart.png"]);
    });
  });

  describe("error mapping", () => {
    it("maps ClaudeProcessError to process-error response", async () => {
      const claude = mockClaude(async () => { throw new ClaudeProcessError(1, "spawn failed"); });
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

      expect(result.action).toBe("send");
      if (result.action === "send") {
        expect(result.message).toContain("[Error]");
        expect(result.message).toContain("spawn failed");
      }
      expect(result.actionReason).toBe("process-error");
    });

    it("maps ClaudeParseError to json-parse-failed response", async () => {
      const claude = mockClaude(async () => { throw new ClaudeParseError("not json"); });
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      const result = await processSync(orch, { type: "user", message: "hi" });

      expect(result.action).toBe("send");
      if (result.action === "send") expect(result.message).toContain("[JSON Error]");
      expect(result.actionReason).toBe("json-parse-failed");
    });

    it("rethrows unknown errors", async () => {
      const claude = mockClaude(async () => { throw new Error("unexpected"); });
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await expect(processSync(orch, { type: "user", message: "hi" })).rejects.toThrow("unexpected");
    });
  });

  describe("session management", () => {
    it("uses --resume for existing session", async () => {
      saveSettings({ sessionId: "existing-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "hello" });

      expect(claude.run.mock.calls[0][0].sessionFlag).toBe("--resume");
      expect(claude.run.mock.calls[0][0].sessionId).toBe("existing-session");
    });

    it("creates new session when no settings exist", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "hello" });

      expect(claude.run.mock.calls[0][0].sessionFlag).toBe("--session-id");
      expect(claude.run.mock.calls[0][0].sessionId).toMatch(/^[0-9a-f]{8}-/);
    });

    it("creates new session when resume fails", async () => {
      saveSettings({ sessionId: "old-session" }, tmpSettingsDir);
      let callCount = 0;
      const claude = mockClaude(async (_opts: ClaudeRunOptions): Promise<ClaudeResult> => {
        callCount++;
        if (callCount === 1) throw new ClaudeProcessError(1, "session not found");
        return successResult({ action: "send", message: "ok", actionReason: "ok" });
      });
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "hello" });

      expect(callCount).toBe(2);
      expect(claude.run.mock.calls[0][0].sessionFlag).toBe("--resume");
      expect(claude.run.mock.calls[1][0].sessionFlag).toBe("--session-id");
      expect(claude.run.mock.calls[1][0].sessionId).not.toBe("old-session");
    });

    it("switches to --resume after first success", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "first" });
      await processSync(orch, { type: "user", message: "second" });

      expect(claude.run.mock.calls[0][0].sessionFlag).toBe("--session-id");
      expect(claude.run.mock.calls[1][0].sessionFlag).toBe("--resume");
    });

    it("exposes sessionId", () => {
      saveSettings({ sessionId: "test-id" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "", actionReason: "" }));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });
      expect(orch.sessionId).toBe("test-id");
    });

    it("background-agent forks from main session without affecting it", async () => {
      saveSettings({ sessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }, "main-session"));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "hello" });
      await processSync(orch, { type: "background-agent", name: "worker", prompt: "work" });
      await processSync(orch, { type: "user", message: "again" });

      expect(claude.run.mock.calls[0][0].sessionId).toBe("main-session");
      expect(claude.run.mock.calls[1][0].sessionId).toBe("main-session"); // forked from main
      expect(claude.run.mock.calls[1][0].forkSession).toBe(true);
      expect(claude.run.mock.calls[2][0].sessionId).toBe("main-session"); // main preserved
      expect(claude.run.mock.calls[2][0].forkSession).toBeUndefined();
    });

    it("updates session ID after forked call", async () => {
      saveSettings({ sessionId: "old-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }, "new-forked-session"));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "hello" }, { forkSession: true });

      expect(claude.run.mock.calls[0][0].forkSession).toBe(true);
      expect(orch.sessionId).toBe("new-forked-session");

      // Next call uses new session ID
      await processSync(orch, { type: "user", message: "follow up" });
      expect(claude.run.mock.calls[1][0].sessionId).toBe("new-forked-session");
    });

    it("does not update session ID when response session matches", async () => {
      saveSettings({ sessionId: "same-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }, "same-session"));
      const orch = new Orchestrator({ workspace: TEST_WORKSPACE, settingsDir: tmpSettingsDir, claude });

      await processSync(orch, { type: "user", message: "hello" });
      expect(orch.sessionId).toBe("same-session");
    });
  });
});
