import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { type Claude, QueryParseError, QueryProcessError, type QueryResult, type RunningQuery } from "./claude";
import { Orchestrator, type OrchestratorConfig, type OrchestratorResponse } from "./orchestrator";
import { saveSessions } from "./sessions";

const tmpSettingsDir = "/tmp/macroclaw-test-orchestrator-settings";
const TEST_WORKSPACE = "/tmp/macroclaw-test-workspace";

beforeEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
});

interface CallInfo {
  method: "newSession" | "resumeSession" | "forkSession";
  prompt: string;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
}

type MockHandler = (info: CallInfo) => RunningQuery<unknown>;

function queryResult<T>(value: T, sessionId = "test-session-id"): QueryResult<T> {
  return { value, sessionId, duration: "1.0s", cost: "$0.05" };
}

function resolvedQuery<T>(value: T, sessionId = "test-session-id"): RunningQuery<T> {
  return {
    sessionId,
    startedAt: new Date(),
    result: Promise.resolve(queryResult(value, sessionId)),
    kill: mock(async () => {}),
  };
}

function mockClaude(handler: MockHandler | unknown) {
  const calls: CallInfo[] = [];
  const handlerFn: MockHandler = typeof handler === "function"
    ? handler as MockHandler
    : () => resolvedQuery(handler);

  const claude = {
    newSession: mock((prompt: string, _resultType: unknown, options?: { model?: string; systemPrompt?: string }) => {
      const info: CallInfo = { method: "newSession", prompt, model: options?.model, systemPrompt: options?.systemPrompt };
      calls.push(info);
      return handlerFn(info);
    }),
    resumeSession: mock((sessionId: string, prompt: string, _resultType: unknown, options?: { model?: string; systemPrompt?: string }) => {
      const info: CallInfo = { method: "resumeSession", sessionId, prompt, model: options?.model, systemPrompt: options?.systemPrompt };
      calls.push(info);
      return handlerFn(info);
    }),
    forkSession: mock((sessionId: string, prompt: string, _resultType: unknown, options?: { model?: string; systemPrompt?: string }) => {
      const info: CallInfo = { method: "forkSession", sessionId, prompt, model: options?.model, systemPrompt: options?.systemPrompt };
      calls.push(info);
      return handlerFn(info);
    }),
    calls,
  } as unknown as Claude & { calls: CallInfo[]; newSession: ReturnType<typeof mock>; resumeSession: ReturnType<typeof mock>; forkSession: ReturnType<typeof mock> };
  return claude;
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
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(claude.calls[0].prompt).toBe("hello");
    });

    it("prepends file references for user requests", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("check this", ["/tmp/photo.jpg", "/tmp/doc.pdf"]);
      await waitForProcessing();

      expect(claude.calls[0].prompt).toBe("[File: /tmp/photo.jpg]\n[File: /tmp/doc.pdf]\ncheck this");
    });

    it("sends only file references when message is empty", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("", ["/tmp/photo.jpg"]);
      await waitForProcessing();

      expect(claude.calls[0].prompt).toBe("[File: /tmp/photo.jpg]");
    });

    it("builds cron prompt with prefix", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleCron("daily", "check updates");
      await waitForProcessing();

      expect(claude.calls[0].prompt).toBe("[Context: cron/daily] check updates");
    });

    it("uses cron model override", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude, { model: "sonnet" });

      orch.handleCron("smart", "think", "opus");
      await waitForProcessing();

      expect(claude.calls[0].model).toBe("opus");
    });

    it("falls back to config model when cron has no model", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude, { model: "sonnet" });

      orch.handleCron("basic", "check");
      await waitForProcessing();

      expect(claude.calls[0].model).toBe("sonnet");
    });

    it("builds button click prompt", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleButton("Yes");
      await waitForProcessing();

      expect(claude.calls[0].prompt).toBe('[Context: button-click] User tapped "Yes"');
    });
  });

  describe("schema validation", () => {
    it("validates and returns structured output via onResponse", async () => {
      const claude = mockClaude({ action: "send", message: "hello", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses).toHaveLength(1);
      expect(responses[0].message).toBe("hello");
    });

    it("passes buttons through onResponse", async () => {
      const output = {
        action: "send",
        message: "Choose",
        actionReason: "ok",
        buttons: ["Yes", "No", "Maybe"],
      };
      const claude = mockClaude(output);
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].buttons).toEqual(["Yes", "No", "Maybe"]);
    });

    it("passes files through onResponse", async () => {
      const output = { action: "send", message: "chart", actionReason: "ok", files: ["/tmp/chart.png"] };
      const claude = mockClaude(output);
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].files).toEqual(["/tmp/chart.png"]);
    });
  });

  describe("error mapping", () => {
    it("maps QueryProcessError to process-error response", async () => {
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "err-sid",
        startedAt: new Date(),
        result: Promise.reject(new QueryProcessError(1, "spawn failed")),
        kill: mock(async () => {}),
      }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toContain("[Error]");
      expect(responses[0].message).toContain("spawn failed");
    });

    it("maps QueryParseError to json-parse-failed response", async () => {
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "err-sid",
        startedAt: new Date(),
        result: Promise.reject(new QueryParseError("not json")),
        kill: mock(async () => {}),
      }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toContain("[JSON Error]");
    });
  });

  describe("session management", () => {
    it("uses resumeSession for existing session", async () => {
      saveSessions({ mainSessionId: "existing-session" }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(claude.calls[0].method).toBe("resumeSession");
      expect(claude.calls[0].sessionId).toBe("existing-session");
    });

    it("uses newSession when no settings exist", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(claude.calls[0].method).toBe("newSession");
    });

    it("creates new session when resume fails", async () => {
      saveSessions({ mainSessionId: "old-session" }, tmpSettingsDir);
      let callCount = 0;
      const claude = mockClaude((_info: CallInfo): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) {
          return {
            sessionId: "old-session",
            startedAt: new Date(),
            result: Promise.reject(new QueryProcessError(1, "session not found")),
            kill: mock(async () => {}),
          };
        }
        return resolvedQuery({ action: "send", message: "ok", actionReason: "ok" });
      });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(callCount).toBe(2);
      expect(claude.calls[0].method).toBe("resumeSession");
      expect(claude.calls[1].method).toBe("newSession");
    });

    it("switches to resumeSession after first success", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("first");
      await waitForProcessing();
      orch.handleMessage("second");
      await waitForProcessing();

      expect(claude.calls[0].method).toBe("newSession");
      expect(claude.calls[1].method).toBe("resumeSession");
    });

    it("handleSessionCommand sends session via onResponse", async () => {
      saveSessions({ mainSessionId: "test-id" }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "", actionReason: "" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleSessionCommand();
      await waitForProcessing();

      expect(responses).toHaveLength(1);
      expect(responses[0].message).toBe("Session: <code>test-id</code>");
    });

    it("background-agent forks from main session", async () => {
      saveSessions({ mainSessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      orch.handleBackgroundCommand("do work");
      await waitForProcessing();

      // bg agent uses forkSession
      expect(claude.calls[1].method).toBe("forkSession");
    });

    it("updates session ID after forked call", async () => {
      saveSessions({ mainSessionId: "old-session" }, tmpSettingsDir);
      const claude = mockClaude(() => resolvedQuery({ action: "send", message: "ok", actionReason: "ok" }, "new-forked-session"));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      // Next call should use the new session ID
      orch.handleMessage("follow up");
      await waitForProcessing();

      expect(claude.calls[1].sessionId).toBe("new-forked-session");
    });
  });

  describe("queue-based processing", () => {
    it("handleMessage queues a user request and calls onResponse", async () => {
      const claude = mockClaude({ action: "send", message: "result", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("test message");
      await waitForProcessing();

      expect(claude.calls).toHaveLength(1);
      expect(responses[0].message).toBe("result");
    });

    it("handleButton queues a button request", async () => {
      const claude = mockClaude({ action: "send", message: "button response", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleButton("Yes");
      await waitForProcessing();

      expect(claude.calls[0].prompt).toBe('[Context: button-click] User tapped "Yes"');
      expect(responses[0].message).toBe("button response");
    });

    it("handleCron queues a cron request with right params", async () => {
      const claude = mockClaude({ action: "send", message: "cron done", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleCron("daily-check", "Check for updates", "haiku");
      await waitForProcessing();

      expect(claude.calls[0].prompt).toBe("[Context: cron/daily-check] Check for updates");
      expect(claude.calls[0].model).toBe("haiku");
      expect(responses[0].message).toBe("cron done");
    });

    it("processes requests serially (FIFO)", async () => {
      const callOrder: number[] = [];
      let firstResolve: () => void;
      const firstCallDone = new Promise<void>((r) => { firstResolve = r; });

      let callNum = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callNum++;
        const n = callNum;
        if (n === 1) {
          return {
            sessionId: "sid",
            startedAt: new Date(),
            result: firstCallDone.then(() => {
              callOrder.push(n);
              return queryResult({ action: "send", message: `call ${n}`, actionReason: "ok" });
            }),
            kill: mock(async () => {}),
          };
        }
        callOrder.push(n);
        return resolvedQuery({ action: "send", message: `call ${n}`, actionReason: "ok" });
      });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("first");
      orch.handleMessage("second");

      await new Promise((r) => setTimeout(r, 10));
      firstResolve!();
      await waitForProcessing();

      expect(claude.calls).toHaveLength(2);
      expect(callOrder).toEqual([1, 2]);
    });

    it("silent response: onResponse not called when action=silent", async () => {
      const claude = mockClaude({ action: "silent", actionReason: "no new results" });
      const { orch, onResponse } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(onResponse).not.toHaveBeenCalled();
    });

    it("background agents spawned from Claude response: calls onResponse with started message", async () => {
      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) {
          return resolvedQuery({
            action: "send",
            message: "Starting research",
            actionReason: "needs research",
            backgroundAgents: [{ name: "research", prompt: "research this" }],
          });
        }
        return resolvedQuery({ action: "send", message: "research result", actionReason: "done" });
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
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      let resolveCompletion: (r: QueryResult<unknown>) => void;
      const completion = new Promise<QueryResult<unknown>>((r) => { resolveCompletion = r; });

      // Mock setTimeout to fire immediately only for the timeout race, not for waitForProcessing
      const origSetTimeout = globalThis.setTimeout;
      const claude = mockClaude((): RunningQuery<unknown> => {
        // Mock setTimeout right before the race happens (synchronously after this returns)
        globalThis.setTimeout = ((fn: Function) => { fn(); return 0 as any; }) as any;
        return {
          sessionId: "test-session",
          startedAt: new Date(),
          result: completion,
          kill: mock(async () => {}),
        };
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("slow task");
      // Restore immediately so waitForProcessing works
      await new Promise((r) => origSetTimeout(r, 10));
      globalThis.setTimeout = origSetTimeout;
      await waitForProcessing();

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("This is taking longer, continuing in the background.");

      resolveCompletion!(queryResult({ action: "send", message: "done!", actionReason: "ok" }));
      await waitForProcessing(100);

      const allMessages = responses.map((r) => r.message);
      expect(allMessages).toContain("done!");
    });

    it("session fork when background agent running on main session", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      let resolveCompletion: (r: QueryResult<unknown>) => void;
      const completion = new Promise<QueryResult<unknown>>((r) => { resolveCompletion = r; });

      const origSetTimeout = globalThis.setTimeout;

      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) {
          globalThis.setTimeout = ((fn: Function) => { fn(); return 0 as any; }) as any;
          return {
            sessionId: "test-session",
            startedAt: new Date(),
            result: completion,
            kill: mock(async () => {}),
          };
        }
        return resolvedQuery({ action: "send", message: "forked response", actionReason: "ok" });
      });
      const { orch } = makeOrchestrator(claude);

      // First message gets deferred (backgrounded on test-session)
      orch.handleMessage("slow task");
      await new Promise((r) => origSetTimeout(r, 10));
      globalThis.setTimeout = origSetTimeout;
      await waitForProcessing();

      // Second message should trigger a fork (background running on test-session = main session)
      orch.handleMessage("follow up");
      await waitForProcessing();

      expect(claude.calls[1].method).toBe("forkSession");

      resolveCompletion!(queryResult({ action: "send", message: "bg done", actionReason: "ok" }));
      await waitForProcessing(50);
    });

    it("background result with matching session: applied directly (no extra Claude call)", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      let resolveCompletion: (r: QueryResult<unknown>) => void;
      const completion = new Promise<QueryResult<unknown>>((r) => { resolveCompletion = r; });

      const origSetTimeout = globalThis.setTimeout;

      const claude = mockClaude((): RunningQuery<unknown> => {
        globalThis.setTimeout = ((fn: Function) => { fn(); return 0 as any; }) as any;
        return {
          sessionId: "test-session",
          startedAt: new Date(),
          result: completion,
          kill: mock(async () => {}),
        };
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("slow");
      await new Promise((r) => origSetTimeout(r, 10));
      globalThis.setTimeout = origSetTimeout;
      await waitForProcessing();

      resolveCompletion!(queryResult({ action: "send", message: "direct result", actionReason: "ok" }, "test-session"));
      await waitForProcessing(100);

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("direct result");
      // Only called once (for the initial slow request, not for the result)
      expect(claude.calls).toHaveLength(1);
    });
  });

  describe("handleBackgroundList", () => {
    it("sends 'no agents' message when none running", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundList();
      await waitForProcessing();

      expect(responses[0].message).toBe("No background agents running.");
    });

    it("includes peek buttons and dismiss when agents are running", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: `bg-${Date.now()}`,
        startedAt: new Date(),
        result: new Promise(() => {}),
        kill: mock(async () => {}),
      }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("long-task");
      await waitForProcessing();

      orch.handleBackgroundList();
      await waitForProcessing();

      const listResponse = responses[responses.length - 1];
      expect(listResponse.message).toContain("long-task");
      expect(listResponse.buttons).toBeDefined();
      expect(listResponse.buttons!.length).toBe(2); // 1 peek + dismiss
      const peekBtn = listResponse.buttons![0];
      expect(typeof peekBtn).toBe("object");
      expect((peekBtn as any).data).toMatch(/^peek:/);
      expect((peekBtn as any).text).toContain("long-task");
      expect(listResponse.buttons![1]).toEqual({ text: "Dismiss", data: "_dismiss" });
    });
  });

  describe("handlePeek", () => {
    it("returns 'not found' for unknown sessionId", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      await orch.handlePeek("nonexistent-session");
      await waitForProcessing();

      expect(responses[0].message).toBe("Agent not found or already finished.");
    });

    it("peeks at running agent and returns status", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) {
          // bg agent — never finishes
          return {
            sessionId: "bg-sid",
            startedAt: new Date(),
            result: new Promise(() => {}),
            kill: mock(async () => {}),
          };
        }
        // peek fork call
        return resolvedQuery("Working on it, 50% done.", "peek-session");
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("research");
      await waitForProcessing();

      // Get the internal session ID from the peek button
      orch.handleBackgroundList();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const peekBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = peekBtn.data.slice(5); // strip "peek:"

      await orch.handlePeek(sessionId);
      await waitForProcessing();

      const messages = responses.map((r) => r.message);
      expect(messages.some((m) => m.includes("Peeking at"))).toBe(true);
      expect(messages.some((m) => m.includes("Working on it"))).toBe(true);
    });

    it("handles Claude error during peek gracefully", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) {
          return {
            sessionId: "bg-sid",
            startedAt: new Date(),
            result: new Promise(() => {}),
            kill: mock(async () => {}),
          };
        }
        return {
          sessionId: "peek-err",
          startedAt: new Date(),
          result: Promise.reject(new Error("connection lost")),
          kill: mock(async () => {}),
        };
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("failing-peek");
      await waitForProcessing();

      orch.handleBackgroundList();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const peekBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = peekBtn.data.slice(5);

      await orch.handlePeek(sessionId);
      await waitForProcessing();

      const messages = responses.map((r) => r.message);
      expect(messages.some((m) => m.includes("Couldn't peek at"))).toBe(true);
    });
  });

  describe("handleBackgroundCommand", () => {
    it("spawns background agent and sends started message", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "bg-sid",
        startedAt: new Date(),
        result: new Promise(() => {}),
        kill: mock(async () => {}),
      }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("research pricing");
      await waitForProcessing();

      expect(responses[0].message).toBe('Background agent "research-pricing" started.');
      expect(claude.calls).toHaveLength(1);
    });
  });

  describe("background management (spawn/adopt)", () => {
    it("spawns background agent and feeds result back to queue", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      let resolvePromise: (r: QueryResult<unknown>) => void;
      const bgResult = new Promise<QueryResult<unknown>>((r) => { resolvePromise = r; });

      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) {
          return {
            sessionId: "bg-sid",
            startedAt: new Date(),
            result: bgResult,
            kill: mock(async () => {}),
          };
        }
        return resolvedQuery({ action: "send", message: "bg result processed", actionReason: "ok" });
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("do something");
      await waitForProcessing();

      expect(responses[0].message).toContain('started.');

      resolvePromise!(queryResult({ action: "send", message: "done!", actionReason: "completed" }));
      await waitForProcessing(100);

      // The bg result gets fed back to the queue and processed
      expect(callCount).toBe(2); // 1 bg agent + 1 bg result fed back
    });

    it("feeds error back to queue on spawn failure", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      let rejectPromise: (e: Error) => void;
      const bgResult = new Promise<QueryResult<unknown>>((_, r) => { rejectPromise = r; });

      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) {
          return {
            sessionId: "bg-sid",
            startedAt: new Date(),
            result: bgResult,
            kill: mock(async () => {}),
          };
        }
        return resolvedQuery({ action: "send", message: "error processed", actionReason: "ok" });
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("failing task");
      await waitForProcessing();

      rejectPromise!(new Error("spawn failed"));
      await waitForProcessing(100);

      // Error should be fed back and processed
      expect(callCount).toBe(2);
      expect(responses[responses.length - 1].message).toBe("error processed");
    });

    it("adopt feeds error back when deferred rejects", async () => {
      saveSessions({ mainSessionId: "adopted-session" }, tmpSettingsDir);
      let rejectCompletion: (err: Error) => void;
      const completion = new Promise<QueryResult<unknown>>((_, r) => { rejectCompletion = r; });

      const origSetTimeout = globalThis.setTimeout;

      const claude = mockClaude((): RunningQuery<unknown> => {
        globalThis.setTimeout = ((fn: Function) => { fn(); return 0 as any; }) as any;
        return {
          sessionId: "adopted-session",
          startedAt: new Date(),
          result: completion,
          kill: mock(async () => {}),
        };
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("slow");
      await new Promise((r) => origSetTimeout(r, 10));
      globalThis.setTimeout = origSetTimeout;
      await waitForProcessing();

      rejectCompletion!(new Error("process crashed"));
      await waitForProcessing(100);

      const messages = responses.map((r) => r.message);
      expect(messages.some((m) => m.includes("[Error]"))).toBe(true);
    });

    it("adopt feeds result back when deferred resolves", async () => {
      saveSessions({ mainSessionId: "adopted-session" }, tmpSettingsDir);
      let resolveCompletion: (r: QueryResult<unknown>) => void;
      const completion = new Promise<QueryResult<unknown>>((r) => { resolveCompletion = r; });

      const origSetTimeout = globalThis.setTimeout;

      const claude = mockClaude((): RunningQuery<unknown> => {
        globalThis.setTimeout = ((fn: Function) => { fn(); return 0 as any; }) as any;
        return {
          sessionId: "adopted-session",
          startedAt: new Date(),
          result: completion,
          kill: mock(async () => {}),
        };
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("slow");
      await new Promise((r) => origSetTimeout(r, 10));
      globalThis.setTimeout = origSetTimeout;
      await waitForProcessing();

      expect(responses[0].message).toContain("taking longer");

      resolveCompletion!(queryResult({ action: "send", message: "completed!", actionReason: "ok" }));
      await waitForProcessing(100);

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("completed!");
    });
  });

  describe("onResponse error handling", () => {
    it("logs error and does not throw when onResponse callback fails", async () => {
      const claude = mockClaude({ action: "send", message: "hello", actionReason: "ok" });
      const failingOnResponse = mock(async (_r: OrchestratorResponse) => { throw new Error("send failed"); });
      const orch = new Orchestrator({
        workspace: TEST_WORKSPACE,
        settingsDir: tmpSettingsDir,
        onResponse: failingOnResponse,
        claude,
      });

      orch.handleBackgroundList();
      await waitForProcessing();

      expect(failingOnResponse).toHaveBeenCalled();
    });
  });
});
