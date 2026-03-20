import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { type Claude, QueryParseError, QueryProcessError, type QueryResult, type RunningQuery } from "./claude";
import { Orchestrator, type OrchestratorConfig, type OrchestratorResponse } from "./orchestrator";
import { saveSessions } from "./sessions";

const tmpSettingsDir = "/tmp/macroclaw-test-orchestrator-settings";
const TEST_WORKSPACE = "/tmp/macroclaw-test-workspace";

function cleanup() {
  try {
    if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
  } catch { /* async completion handlers may race with cleanup */ }
}

beforeEach(cleanup);
afterEach(cleanup);

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

function pendingQuery(sessionId = "pending-sid"): { query: RunningQuery<unknown>; resolve: (v: QueryResult<unknown>) => void; reject: (e: Error) => void } {
  let resolve!: (v: QueryResult<unknown>) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<QueryResult<unknown>>((res, rej) => { resolve = res; reject = rej; });
  return {
    query: { sessionId, startedAt: new Date(), result, kill: mock(async () => {}) },
    resolve,
    reject,
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

    it("reports error when resume fails", async () => {
      saveSessions({ mainSessionId: "old-session" }, tmpSettingsDir);
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "old-session",
        startedAt: new Date(),
        result: Promise.reject(new QueryProcessError(1, "session not found")),
        kill: mock(async () => {}),
      }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(claude.calls[0].method).toBe("resumeSession");
      expect(responses[0].message).toContain("[Error]");
      expect(responses[0].message).toContain("session not found");
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

    it("background-agent forks from main session", async () => {
      saveSessions({ mainSessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      orch.handleBackgroundCommand("do work");
      await waitForProcessing();

      expect(claude.calls[1].method).toBe("forkSession");
    });

    it("updates session ID after forked call", async () => {
      saveSessions({ mainSessionId: "old-session" }, tmpSettingsDir);
      const claude = mockClaude(() => resolvedQuery({ action: "send", message: "ok", actionReason: "ok" }, "new-forked-session"));
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      orch.handleMessage("follow up");
      await waitForProcessing();

      expect(claude.calls[1].sessionId).toBe("new-forked-session");
    });
  });

  describe("non-blocking handler", () => {
    it("handler returns immediately, result delivered by completion handler", async () => {
      const { query, resolve } = pendingQuery("main-sid");
      const claude = mockClaude(() => query);
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      // Handler returned but no response yet (query still pending)
      expect(responses).toHaveLength(0);

      // Query completes — completion handler delivers
      resolve(queryResult({ action: "send", message: "done!", actionReason: "ok" }));
      await waitForProcessing();

      expect(responses[0].message).toBe("done!");
    });

    it("second message processes while first is still running", async () => {
      const { query: q1, resolve: resolve1 } = pendingQuery("q1-sid");
      const { query: q2, resolve: resolve2 } = pendingQuery("q2-sid");

      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) return q1;
        return q2;
      });
      // waitThreshold=0 so second message demotes immediately
      const { orch, responses } = makeOrchestrator(claude, { waitThreshold: 0 });

      orch.handleMessage("first");
      await waitForProcessing();

      // First query is running, handler returned
      expect(callCount).toBe(1);

      orch.handleMessage("second");
      await waitForProcessing();

      // Second message caused a fork+demote, second query started
      expect(callCount).toBe(2);
      const secondCall = claude.calls[1];
      expect(secondCall.method).toBe("forkSession");
      expect(secondCall.prompt).toContain("[Context: previous task");
      expect(secondCall.prompt).toContain("moved to background]");
      expect(secondCall.prompt).toContain("second");

      // Resolve both
      resolve2(queryResult({ action: "send", message: "second done", actionReason: "ok" }, "q2-sid"));
      resolve1(queryResult({ action: "send", message: "first done", actionReason: "ok" }, "q1-sid"));
      await waitForProcessing(100);

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("second done");
      // First result goes through Claude as background context (not direct)
    });

    it("waits for main to finish when within threshold, then processes next message", async () => {
      const { query: q1, resolve: resolve1 } = pendingQuery("main-sid");

      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) return q1;
        return resolvedQuery({ action: "send", message: "follow-up result", actionReason: "ok" });
      });
      const { orch, responses } = makeOrchestrator(claude);

      // First message — handler returns immediately
      orch.handleMessage("slow task");
      await waitForProcessing();
      expect(callCount).toBe(1);

      // Second message — main is running, within threshold, handler blocks
      orch.handleMessage("follow up");
      await waitForProcessing(10);

      // Still blocked, only 1 call
      expect(callCount).toBe(1);

      // First query finishes — completion handler delivers, then handler unblocks
      resolve1(queryResult({ action: "send", message: "slow done", actionReason: "ok" }));
      await waitForProcessing(100);

      expect(callCount).toBe(2);
      const messages = responses.map((r) => r.message);
      expect(messages).toContain("slow done");
      expect(messages).toContain("follow-up result");
    });

    it("demotes after wait timeout when main does not finish in time", async () => {
      const { query: q1 } = pendingQuery("main-sid");

      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) return q1;
        return resolvedQuery({ action: "send", message: "forked result", actionReason: "ok" }, "new-main");
      });
      // Short threshold so we don't wait long
      const { orch, responses } = makeOrchestrator(claude, { waitThreshold: 10 });

      orch.handleMessage("slow task");
      await waitForProcessing();

      orch.handleMessage("follow up");
      await waitForProcessing(200);

      expect(callCount).toBe(2);
      const userCall = claude.calls[1];
      expect(userCall.prompt).toContain("[Context: previous task");
      expect(userCall.prompt).toContain("follow up");
      expect(responses.map((r) => r.message)).toContain("forked result");
    });

    it("delivers result with error when session not in runningSessions", async () => {
      saveSessions({ mainSessionId: "main-session" }, tmpSettingsDir);
      const { query, resolve } = pendingQuery("main-session");
      const claude = mockClaude(() => query);
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      // Kill the session (removes from runningSessions)
      await orch.handleKill("main-session");
      await waitForProcessing();

      // Query completes after kill — should still deliver (with error log)
      resolve(queryResult({ action: "send", message: "late result", actionReason: "ok" }));
      await waitForProcessing();

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("late result");
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

      await waitForProcessing(100);
      expect(callCount).toBe(3); // 1 main + 1 bg agent + 1 bg result fed back
    });
  });

  describe("cron routing", () => {
    it("cron always forks as background, never goes through queue", async () => {
      saveSessions({ mainSessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleCron("daily-check", "Check for updates", "haiku");
      await waitForProcessing();

      expect(claude.calls[0].method).toBe("forkSession");
      expect(claude.calls[0].prompt).toContain("[Context: background-agent/cron-daily-check]");
      expect(claude.calls[0].prompt).toContain("[Context: cron/daily-check] Check for updates");
      expect(claude.calls[0].model).toBe("haiku");
    });

    it("cron uses config model when none specified", async () => {
      saveSessions({ mainSessionId: "main-session" }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude, { model: "sonnet" });

      orch.handleCron("basic", "check");
      await waitForProcessing();

      expect(claude.calls[0].model).toBe("sonnet");
    });

    it("cron result feeds back into main session", async () => {
      saveSessions({ mainSessionId: "main-session" }, tmpSettingsDir);
      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        return resolvedQuery({ action: "send", message: `call ${callCount}`, actionReason: "ok" });
      });
      const { orch } = makeOrchestrator(claude);

      orch.handleCron("check", "any updates?");
      await waitForProcessing(150);

      expect(callCount).toBe(2); // 1 cron bg + 1 bg result fed back
    });
  });

  describe("handleSessions", () => {
    it("sends 'no sessions' message when none running", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleSessions();
      await waitForProcessing();

      expect(responses[0].message).toBe("No running sessions.");
    });

    it("includes detail buttons and dismiss when sessions are running", async () => {
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

      orch.handleSessions();
      await waitForProcessing();

      const listResponse = responses[responses.length - 1];
      expect(listResponse.message).toContain("long-task");
      expect(listResponse.buttons).toBeDefined();
      expect(listResponse.buttons!.length).toBe(2);
      const detailBtn = listResponse.buttons![0];
      expect(typeof detailBtn).toBe("object");
      expect((detailBtn as any).data).toMatch(/^detail:/);
      expect((detailBtn as any).text).toContain("long-task");
      expect(listResponse.buttons![1]).toEqual({ text: "Dismiss", data: "_dismiss" });
    });

    it("marks main session in listing", async () => {
      const { query } = pendingQuery("main-sid");
      const claude = mockClaude(() => query);
      const { orch, responses } = makeOrchestrator(claude);

      // Start a main query (non-blocking, stays in runningSessions)
      orch.handleMessage("task");
      await waitForProcessing();

      orch.handleSessions();
      await waitForProcessing();

      const listResponse = responses[responses.length - 1];
      expect(listResponse.message).toContain("[main]");
    });
  });

  describe("handlePeek", () => {
    it("returns 'not found' for unknown sessionId", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      await orch.handlePeek("nonexistent-session");
      await waitForProcessing();

      expect(responses[0].message).toBe("Session not found or already finished.");
    });

    it("peeks at running agent and returns status", async () => {
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
        return resolvedQuery("Working on it, 50% done.", "peek-session");
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("research");
      await waitForProcessing();

      orch.handleSessions();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const detailBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = detailBtn.data.slice(7);

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

      orch.handleSessions();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const detailBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = detailBtn.data.slice(7);

      await orch.handlePeek(sessionId);
      await waitForProcessing();

      const messages = responses.map((r) => r.message);
      expect(messages.some((m) => m.includes("Couldn't peek at"))).toBe(true);
    });
  });

  describe("handleDetail", () => {
    it("returns 'not found' for unknown sessionId", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleDetail("nonexistent-session");
      await waitForProcessing();

      expect(responses[0].message).toBe("Session not found or already finished.");
    });

    it("shows session details with peek/kill/dismiss buttons", async () => {
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

      orch.handleSessions();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const detailBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = detailBtn.data.slice(7);

      orch.handleDetail(sessionId);
      await waitForProcessing();

      const detailResponse = responses[responses.length - 1];
      expect(detailResponse.message).toContain("research-pricing");
      expect(detailResponse.message).toContain("research pricing");
      expect(detailResponse.message).toContain("default");
      expect(detailResponse.message).toContain("Status: running");
      expect(detailResponse.buttons).toHaveLength(3);
      expect(detailResponse.buttons![0]).toEqual({ text: "Peek", data: `peek:${sessionId}` });
      expect(detailResponse.buttons![1]).toEqual({ text: "Kill", data: `kill:${sessionId}` });
      expect(detailResponse.buttons![2]).toEqual({ text: "Dismiss", data: "_dismiss" });
    });

    it("truncates prompt at 300 chars", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      const longPrompt = "a".repeat(500);
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "bg-sid",
        startedAt: new Date(),
        result: new Promise(() => {}),
        kill: mock(async () => {}),
      }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand(longPrompt);
      await waitForProcessing();

      orch.handleSessions();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const detailBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = detailBtn.data.slice(7);

      orch.handleDetail(sessionId);
      await waitForProcessing();

      const detailResponse = responses[responses.length - 1];
      expect(detailResponse.message).toContain("a".repeat(300));
      expect(detailResponse.message).toContain("…");
      expect(detailResponse.message).not.toContain("a".repeat(301));
    });

    it("shows model when specified", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "bg-sid",
        startedAt: new Date(),
        result: new Promise(() => {}),
        kill: mock(async () => {}),
      }));
      const { orch, responses } = makeOrchestrator(claude, { model: "opus" });

      orch.handleBackgroundCommand("research");
      await waitForProcessing();

      orch.handleSessions();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const detailBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = detailBtn.data.slice(7);

      orch.handleDetail(sessionId);
      await waitForProcessing();

      const detailResponse = responses[responses.length - 1];
      expect(detailResponse.message).toContain("Model: opus");
    });
  });

  describe("handleKill", () => {
    it("returns 'not found' for unknown sessionId", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch, responses } = makeOrchestrator(claude);

      await orch.handleKill("nonexistent-session");
      await waitForProcessing();

      expect(responses[0].message).toBe("Session not found or already finished.");
    });

    it("kills running session and sends confirmation", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      const killMock = mock(async () => {});
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "bg-sid",
        startedAt: new Date(),
        result: new Promise(() => {}),
        kill: killMock,
      }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("research pricing");
      await waitForProcessing();

      orch.handleSessions();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const detailBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = detailBtn.data.slice(7);

      await orch.handleKill(sessionId);
      await waitForProcessing();

      expect(killMock).toHaveBeenCalled();
      const killResponse = responses[responses.length - 1];
      expect(killResponse.message).toContain("Killed");
      expect(killResponse.message).toContain("research-pricing");

      orch.handleSessions();
      await waitForProcessing();
      expect(responses[responses.length - 1].message).toBe("No running sessions.");
    });

    it("does not feed error back to queue after kill", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      let rejectBg: (err: Error) => void;
      const bgResult = new Promise<never>((_, r) => { rejectBg = r; });
      const claude = mockClaude((): RunningQuery<unknown> => ({
        sessionId: "bg-sid",
        startedAt: new Date(),
        result: bgResult,
        kill: mock(async () => {}),
      }));
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("task");
      await waitForProcessing();

      orch.handleSessions();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const detailBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = detailBtn.data.slice(7);

      await orch.handleKill(sessionId);
      await waitForProcessing();
      const countAfterKill = responses.length;

      rejectBg!(new Error("process killed"));
      await waitForProcessing(100);

      const newResponses = responses.slice(countAfterKill);
      expect(newResponses.every((r) => !r.message.includes("[Error]"))).toBe(true);
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

  describe("background management", () => {
    it("spawns background agent and feeds result back to queue", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      const { query: bgQuery, resolve: resolveBg } = pendingQuery("bg-sid");

      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) return bgQuery;
        return resolvedQuery({ action: "send", message: "bg result processed", actionReason: "ok" });
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("do something");
      await waitForProcessing();

      expect(responses[0].message).toContain('started.');

      resolveBg(queryResult({ action: "send", message: "done!", actionReason: "completed" }));
      await waitForProcessing(100);

      expect(callCount).toBe(2);
    });

    it("feeds error back to queue on spawn failure", async () => {
      saveSessions({ mainSessionId: "test-session" }, tmpSettingsDir);
      const { query: bgQuery, reject: rejectBg } = pendingQuery("bg-sid");

      let callCount = 0;
      const claude = mockClaude((): RunningQuery<unknown> => {
        callCount++;
        if (callCount === 1) return bgQuery;
        return resolvedQuery({ action: "send", message: "error processed", actionReason: "ok" });
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("failing task");
      await waitForProcessing();

      rejectBg(new Error("spawn failed"));
      await waitForProcessing(100);

      expect(callCount).toBe(2);
      expect(responses[responses.length - 1].message).toBe("error processed");
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

      orch.handleSessions();
      await waitForProcessing();

      expect(failingOnResponse).toHaveBeenCalled();
    });
  });
});
