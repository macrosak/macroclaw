import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { type Claude, type ClaudeDeferredResult, ClaudeParseError, ClaudeProcessError, type ClaudeResult, type ClaudeRunOptions } from "./claude";
import { Orchestrator, type OrchestratorConfig, type OrchestratorResponse } from "./orchestrator";
import { saveSettings } from "./settings";

const tmpSettingsDir = "/tmp/macroclaw-test-orchestrator-settings";
const TEST_WORKSPACE = "/tmp/macroclaw-test-workspace";

beforeEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

function mockClaude(response: ClaudeResult | ((opts: ClaudeRunOptions) => Promise<ClaudeResult | ClaudeDeferredResult>)) {
  const run = typeof response === "function"
    ? mock(response)
    : mock(async () => response);
  return { run } as unknown as Claude & { run: ReturnType<typeof mock> };
}

function successResult(structuredOutput: unknown, sessionId = "test-session-id"): ClaudeResult {
  return { structuredOutput, sessionId, duration: "1.0s", cost: "$0.05" };
}

function makeOrchestrator(claude: Claude, extraConfig?: Partial<OrchestratorConfig>) {
  const responses: OrchestratorResponse[] = [];
  const onResponse = mock(async (r: OrchestratorResponse) => { responses.push(r); });
  const orch = new Orchestrator({
    workspace: TEST_WORKSPACE,
    settingsDir: tmpSettingsDir,
    onResponse,
    claude,
    ...extraConfig,
  });
  return { orch, responses, onResponse };
}

async function waitForProcessing(ms = 50) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("Orchestrator", () => {
  describe("prompt building", () => {
    it("builds user prompt as-is", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe("hello");
      expect(opts.systemPrompt).toContain("direct message from the user");
      expect(opts.timeoutMs).toBe(60_000);
    });

    it("prepends file references for user requests", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("check this", ["/tmp/photo.jpg", "/tmp/doc.pdf"]);
      await waitForProcessing();

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe("[File: /tmp/photo.jpg]\n[File: /tmp/doc.pdf]\ncheck this");
    });

    it("sends only file references when message is empty", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("", ["/tmp/photo.jpg"]);
      await waitForProcessing();

      expect(claude.run.mock.calls[0][0].prompt).toBe("[File: /tmp/photo.jpg]");
    });

    it("builds cron prompt with prefix", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude);

      orch.handleCron("daily", "check updates");
      await waitForProcessing();

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe("[Tool: cron/daily] check updates");
      expect(opts.systemPrompt).toContain("cron event");
      expect(opts.timeoutMs).toBe(300_000);
    });

    it("uses cron model override", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude, { model: "sonnet" });

      orch.handleCron("smart", "think", "opus");
      await waitForProcessing();

      expect(claude.run.mock.calls[0][0].model).toBe("opus");
    });

    it("falls back to config model when cron has no model", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude, { model: "sonnet" });

      orch.handleCron("basic", "check");
      await waitForProcessing();

      expect(claude.run.mock.calls[0][0].model).toBe("sonnet");
    });

    it("builds button click prompt", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude);

      orch.handleButton("Yes");
      await waitForProcessing();

      const opts = claude.run.mock.calls[0][0];
      expect(opts.prompt).toBe('The user clicked MessageButton: "Yes"');
      expect(opts.systemPrompt).toContain("tapped an inline keyboard button");
      expect(opts.timeoutMs).toBe(60_000);
    });
  });

  describe("schema validation", () => {
    it("validates and returns structured output via onResponse", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "hello", actionReason: "ok" }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses).toHaveLength(1);
      expect(responses[0].message).toBe("hello");
    });

    it("returns validation-failed response for wrong shape", async () => {
      const claude = mockClaude(successResult({ action: "invalid", message: "hi", actionReason: "ok" }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toBe("hi");
    });

    it("sends result with prefix when structured_output is missing", async () => {
      const claude = mockClaude({ structuredOutput: null, sessionId: "s1", result: "Claude said this" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toContain("Claude said this");
    });

    it("escapes HTML in fallback result to prevent Telegram parse errors", async () => {
      const claude = mockClaude({ structuredOutput: null, sessionId: "s1", result: "<b>bold</b> & stuff" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toBe("&lt;b&gt;bold&lt;/b&gt; &amp; stuff");
    });

    it("returns [No output] when both structured_output and result are missing", async () => {
      const claude = mockClaude({ structuredOutput: null, sessionId: "s1" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toBe("[No output]");
    });

    it("passes buttons through onResponse", async () => {
      const output = {
        action: "send",
        message: "Choose",
        actionReason: "ok",
        buttons: [[{ label: "Yes" }, { label: "No" }], [{ label: "Maybe" }]],
      };
      const claude = mockClaude(successResult(output));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].buttons).toEqual([[{ label: "Yes" }, { label: "No" }], [{ label: "Maybe" }]]);
    });

    it("passes files through onResponse", async () => {
      const output = { action: "send", message: "chart", actionReason: "ok", files: ["/tmp/chart.png"] };
      const claude = mockClaude(successResult(output));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].files).toEqual(["/tmp/chart.png"]);
    });
  });

  describe("error mapping", () => {
    it("maps ClaudeProcessError to process-error response", async () => {
      const claude = mockClaude(async () => { throw new ClaudeProcessError(1, "spawn failed"); });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toContain("[Error]");
      expect(responses[0].message).toContain("spawn failed");
    });

    it("maps ClaudeParseError to json-parse-failed response", async () => {
      const claude = mockClaude(async () => { throw new ClaudeParseError("not json"); });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toContain("[JSON Error]");
    });
  });

  describe("session management", () => {
    it("uses --resume for existing session", async () => {
      saveSettings({ sessionId: "existing-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(claude.run.mock.calls[0][0].sessionFlag).toBe("--resume");
      expect(claude.run.mock.calls[0][0].sessionId).toBe("existing-session");
    });

    it("creates new session when no settings exist", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

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
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(callCount).toBe(2);
      expect(claude.run.mock.calls[0][0].sessionFlag).toBe("--resume");
      expect(claude.run.mock.calls[1][0].sessionFlag).toBe("--session-id");
      expect(claude.run.mock.calls[1][0].sessionId).not.toBe("old-session");
    });

    it("switches to --resume after first success", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("first");
      await waitForProcessing();
      orch.handleMessage("second");
      await waitForProcessing();

      expect(claude.run.mock.calls[0][0].sessionFlag).toBe("--session-id");
      expect(claude.run.mock.calls[1][0].sessionFlag).toBe("--resume");
    });

    it("handleSessionCommand sends session via onResponse", async () => {
      saveSettings({ sessionId: "test-id" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "", actionReason: "" }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleSessionCommand();
      await waitForProcessing();

      expect(responses).toHaveLength(1);
      expect(responses[0].message).toBe("Session: <code>test-id</code>");
    });

    it("background-agent forks from main session without affecting it", async () => {
      saveSettings({ sessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }, "main-session"));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      // Trigger a background agent spawn via a response with backgroundAgents
      // The background agent is spawned by #deliverClaudeResponse
      // We can't directly call handleBackgroundCommand here because it uses #spawnBackground
      // which calls #processRequest (background-agent type)
      // So let's verify via handleBackgroundCommand
      orch.handleBackgroundCommand("do work");
      await waitForProcessing();

      // background-agent should use --resume and forkSession
      expect(claude.run.mock.calls[1][0].sessionFlag).toBe("--resume");
      expect(claude.run.mock.calls[1][0].forkSession).toBe(true);
    });

    it("updates session ID after forked call", async () => {
      saveSettings({ sessionId: "old-session" }, tmpSettingsDir);
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }, "new-forked-session"));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      // Next call should use the new session ID
      orch.handleMessage("follow up");
      await waitForProcessing();

      expect(claude.run.mock.calls[1][0].sessionId).toBe("new-forked-session");
    });
  });

  describe("queue-based processing", () => {
    it("handleMessage queues a user request and calls onResponse", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "result", actionReason: "ok" }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("test message");
      await waitForProcessing();

      expect(claude.run).toHaveBeenCalledTimes(1);
      expect(responses[0].message).toBe("result");
    });

    it("handleButton queues a button request", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "button response", actionReason: "ok" }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleButton("Yes");
      await waitForProcessing();

      expect(claude.run.mock.calls[0][0].prompt).toBe('The user clicked MessageButton: "Yes"');
      expect(responses[0].message).toBe("button response");
    });

    it("handleCron queues a cron request with right params", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "cron done", actionReason: "ok" }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleCron("daily-check", "Check for updates", "haiku");
      await waitForProcessing();

      expect(claude.run.mock.calls[0][0].prompt).toBe("[Tool: cron/daily-check] Check for updates");
      expect(claude.run.mock.calls[0][0].model).toBe("haiku");
      expect(responses[0].message).toBe("cron done");
    });

    it("processes requests serially (FIFO)", async () => {
      const callOrder: number[] = [];
      let firstResolve: () => void;
      const firstCallDone = new Promise<void>((r) => { firstResolve = r; });

      const claude = mockClaude(async (_opts: ClaudeRunOptions): Promise<ClaudeResult> => {
        const callNum = (claude as any).run.mock.calls.length;
        if (callNum === 1) {
          await firstCallDone;
        }
        callOrder.push(callNum);
        return successResult({ action: "send", message: `call ${callNum}`, actionReason: "ok" });
      });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("first");
      orch.handleMessage("second");

      // Let first call start but not finish
      await new Promise((r) => setTimeout(r, 10));
      firstResolve!();
      await waitForProcessing();

      // Verify they ran in order
      expect((claude as any).run).toHaveBeenCalledTimes(2);
      expect(callOrder).toEqual([1, 2]);
    });

    it("silent response: onResponse not called when action=silent", async () => {
      const claude = mockClaude(successResult({ action: "silent", actionReason: "no new results" }));
      const { orch, onResponse } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(onResponse).not.toHaveBeenCalled();
    });

    it("background agents spawned from Claude response: calls onResponse with started message", async () => {
      let callCount = 0;
      const claude = mockClaude(async (): Promise<ClaudeResult> => {
        callCount++;
        if (callCount === 1) {
          return successResult({
            action: "send",
            message: "Starting research",
            actionReason: "needs research",
            backgroundAgents: [{ name: "research", prompt: "research this" }],
          });
        }
        return successResult({ action: "send", message: "research result", actionReason: "done" });
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("Starting research");
      expect(messages).toContain('Background agent "research" started.');

      // Background agent result should be fed back
      await waitForProcessing(100);
      expect(callCount).toBe(3); // 1 main + 1 bg agent + 1 bg result fed back
    });

    it("deferred → sends 'taking longer' via onResponse, feeds result back when resolved", async () => {
      saveSettings({ sessionId: "test-session" }, tmpSettingsDir);
      let resolveCompletion: (r: ClaudeResult) => void;
      const completion = new Promise<ClaudeResult>((r) => { resolveCompletion = r; });
      const claude = mockClaude(async (): Promise<ClaudeResult | ClaudeDeferredResult> =>
        ({ deferred: true, sessionId: "test-session", completion }),
      );
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("slow task");
      await waitForProcessing();

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("This is taking longer, continuing in the background.");

      resolveCompletion!(successResult({ action: "send", message: "done!", actionReason: "ok" }));
      await waitForProcessing(100);

      const allMessages = responses.map((r) => r.message);
      expect(allMessages).toContain("done!");
    });

    it("session fork when background agent running on main session", async () => {
      saveSettings({ sessionId: "test-session" }, tmpSettingsDir);
      let resolveCompletion: (r: ClaudeResult) => void;
      const completion = new Promise<ClaudeResult>((r) => { resolveCompletion = r; });
      let callCount = 0;
      const claude = mockClaude(async (): Promise<ClaudeResult | ClaudeDeferredResult> => {
        callCount++;
        if (callCount === 1) return { deferred: true, sessionId: "test-session", completion };
        return successResult({ action: "send", message: "forked response", actionReason: "ok" });
      });
      const { orch } = makeOrchestrator(claude);

      // First message gets deferred (backgrounded on test-session)
      orch.handleMessage("slow task");
      await waitForProcessing();

      // Second message should trigger a fork (background running on test-session = main session)
      orch.handleMessage("follow up");
      await waitForProcessing();

      const opts = (claude as any).run.mock.calls[1][0] as ClaudeRunOptions;
      expect(opts.forkSession).toBe(true);

      resolveCompletion!(successResult({ action: "send", message: "bg done", actionReason: "ok" }));
      await waitForProcessing(50);
    });

    it("background result with matching session: applied directly (no extra Claude call)", async () => {
      saveSettings({ sessionId: "test-session" }, tmpSettingsDir);
      // Use a deferred claude to simulate the scenario where a task is backgrounded
      let resolveCompletion: (r: ClaudeResult) => void;
      const completion = new Promise<ClaudeResult>((r) => { resolveCompletion = r; });
      const deferredClaude = mockClaude(async (): Promise<ClaudeResult | ClaudeDeferredResult> =>
        ({ deferred: true, sessionId: "test-session", completion }),
      );
      const { orch: orch2, responses: responses2 } = makeOrchestrator(deferredClaude);

      orch2.handleMessage("slow");
      await waitForProcessing();
      // Now test-session is tracked as adopted

      // Resolve with a result that has sessionId matching
      resolveCompletion!(successResult({ action: "send", message: "direct result", actionReason: "ok" }, "test-session"));
      await waitForProcessing(100);

      const messages = responses2.map((r) => r.message);
      expect(messages).toContain("direct result");
      // The deferred claude was only called once (for the initial slow request, not for the result)
      expect(deferredClaude.run).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleBackgroundList", () => {
    it("sends 'no agents' message when none running", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "ok", actionReason: "ok" }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundList();
      await waitForProcessing();

      expect(responses[0].message).toBe("No background agents running.");
    });
  });

  describe("handleBackgroundCommand", () => {
    it("spawns background agent and sends started message", async () => {
      const claude = mockClaude(() => new Promise<ClaudeResult>(() => {}));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("research pricing");
      await waitForProcessing();

      expect(responses[0].message).toBe('Background agent "research-pricing" started.');
      expect((claude as any).run).toHaveBeenCalledTimes(1);
    });
  });

  describe("background management (spawn/adopt)", () => {
    it("spawns background agent and feeds result back to queue", async () => {
      let resolvePromise: (r: ClaudeResult) => void;
      const claudePromise = new Promise<ClaudeResult>((r) => {
        resolvePromise = r;
      });
      let callCount = 0;
      const claude = mockClaude(async (): Promise<ClaudeResult> => {
        callCount++;
        if (callCount === 1) return claudePromise;
        return successResult({ action: "send", message: "bg result processed", actionReason: "ok" });
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("do something");
      await waitForProcessing();

      expect(responses[0].message).toContain('started.');

      resolvePromise!(successResult({ action: "send", message: "done!", actionReason: "completed" }));
      await claudePromise;
      await waitForProcessing(100);

      // The bg result gets fed back to the queue and processed
      expect(callCount).toBe(2); // 1 bg agent + 1 bg result fed back
    });

    it("feeds error back to queue on spawn failure", async () => {
      let rejectPromise: (e: Error) => void;
      const claudePromise = new Promise<ClaudeResult>((_, r) => {
        rejectPromise = r;
      });
      let callCount = 0;
      const claude = mockClaude(async (): Promise<ClaudeResult> => {
        callCount++;
        if (callCount === 1) return claudePromise;
        return successResult({ action: "send", message: "error processed", actionReason: "ok" });
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("failing task");
      await waitForProcessing();

      rejectPromise!(new Error("spawn failed"));
      try { await claudePromise; } catch {}
      await waitForProcessing(100);

      // Error should be fed back and processed
      expect(callCount).toBe(2);
      expect(responses[responses.length - 1].message).toBe("error processed");
    });

    it("adopt feeds result back when deferred resolves", async () => {
      saveSettings({ sessionId: "adopted-session" }, tmpSettingsDir);
      let resolveCompletion: (r: ClaudeResult) => void;
      const completion = new Promise<ClaudeResult>((r) => { resolveCompletion = r; });
      const claude = mockClaude(async (): Promise<ClaudeResult | ClaudeDeferredResult> =>
        ({ deferred: true, sessionId: "adopted-session", completion }),
      );
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("slow");
      await waitForProcessing();

      expect(responses[0].message).toContain("taking longer");

      resolveCompletion!(successResult({ action: "send", message: "completed!", actionReason: "ok" }));
      await waitForProcessing(100);

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("completed!");
    });

    it("adopt feeds error back when completion rejects", async () => {
      saveSettings({ sessionId: "adopted-session" }, tmpSettingsDir);
      let rejectCompletion: (e: Error) => void;
      const completion = new Promise<ClaudeResult>((_, r) => { rejectCompletion = r; });
      const claude = mockClaude(async (): Promise<ClaudeResult | ClaudeDeferredResult> =>
        ({ deferred: true, sessionId: "adopted-session", completion }),
      );
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("slow");
      await waitForProcessing();
      expect(responses[0].message).toContain("taking longer");

      rejectCompletion!(new Error("network failure"));
      try { await completion; } catch {}
      await waitForProcessing(100);

      const messages = responses.map((r) => r.message);
      expect(messages.some((m) => m.includes("[Error]"))).toBe(true);
    });
  });

  describe("onResponse error handling", () => {
    it("logs error and does not throw when onResponse callback fails", async () => {
      const claude = mockClaude(successResult({ action: "send", message: "hello", actionReason: "ok" }));
      const failingOnResponse = mock(async (_r: OrchestratorResponse) => { throw new Error("send failed"); });
      const orch = new Orchestrator({
        workspace: TEST_WORKSPACE,
        settingsDir: tmpSettingsDir,
        onResponse: failingOnResponse,
        claude,
      });

      // handleBackgroundList and handleBackgroundCommand use #callOnResponse
      orch.handleBackgroundList();
      await waitForProcessing();

      // Should not throw — error is caught internally
      expect(failingOnResponse).toHaveBeenCalled();
    });
  });
});
