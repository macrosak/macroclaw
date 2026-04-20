import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { type Claude, type ClaudeProcess, type ProcessState, QueryParseError, QueryProcessError, type QueryResult } from "./claude";
import { Orchestrator, type OrchestratorConfig, type OrchestratorResponse } from "./orchestrator";
import { saveSessions } from "./sessions";

const tmpSettingsDir = "/tmp/macroclaw-test-orchestrator-settings";
const TEST_WORKSPACE = "/tmp/macroclaw-test-workspace";

const activeOrchestrators: Orchestrator[] = [];

function cleanup() {
  try {
    if (existsSync(tmpSettingsDir)) rmSync(tmpSettingsDir, { recursive: true });
  } catch { /* async completion handlers may race with cleanup */ }
}

beforeEach(cleanup);
afterEach(async () => {
  for (const orch of activeOrchestrators.splice(0)) {
    await orch.dispose();
  }
  cleanup();
});

interface CallInfo {
  method: "newSession" | "resumeSession" | "forkSession";
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
}

function queryResult<T>(value: T, sessionId = "test-session-id"): QueryResult<T> {
  return { value, sessionId, duration: "1.0s", cost: "$0.05" };
}

/** Creates a mock process that auto-resolves send() with a fixed value */
function autoProcess(value: unknown, sessionId = "test-sid"): ClaudeProcess<unknown> {
  return {
    sessionId,
    startedAt: new Date(),
    get state(): ProcessState { return "idle"; },
    send: mock(async (_prompt: string) => queryResult(value, sessionId)),
    kill: mock(async () => {}),
  } as unknown as ClaudeProcess<unknown>;
}

/** Creates a mock process with controllable send() */
function pendingProcess(sessionId = "pending-sid") {
  type SendEntry = { resolve: (v: QueryResult<unknown>) => void; reject: (e: Error) => void };
  const sendQueue: SendEntry[] = [];
  let state: ProcessState = "idle";

  const proc = {
    sessionId,
    startedAt: new Date(),
    get state(): ProcessState { return state; },
    send: mock(async (_prompt: string): Promise<QueryResult<unknown>> => {
      state = "busy";
      return new Promise<QueryResult<unknown>>((resolve, reject) => {
        sendQueue.push({ resolve, reject });
      });
    }),
    kill: mock(async () => { state = "dead"; }),
  } as unknown as ClaudeProcess<unknown>;

  return {
    process: proc,
    resolve: (value: unknown) => {
      state = "idle";
      const entry = sendQueue.shift();
      if (entry) entry.resolve(queryResult(value, sessionId));
    },
    reject: (err: Error) => {
      state = "dead";
      const entry = sendQueue.shift();
      if (entry) entry.reject(err);
    },
  };
}

type MockHandler = (info: CallInfo) => ClaudeProcess<unknown>;

function mockClaude(handler: MockHandler | unknown) {
  const calls: CallInfo[] = [];
  const processes: ClaudeProcess<unknown>[] = [];
  const handlerFn: MockHandler = typeof handler === "function"
    ? handler as MockHandler
    : () => autoProcess(handler);

  function handleCall(info: CallInfo): ClaudeProcess<unknown> {
    calls.push(info);
    const proc = handlerFn(info);
    processes.push(proc);
    return proc;
  }

  const claude = {
    newSession: mock((_resultType: unknown, options?: { model?: string; systemPrompt?: string }) => {
      return handleCall({ method: "newSession", model: options?.model, systemPrompt: options?.systemPrompt });
    }),
    resumeSession: mock((sessionId: string, _resultType: unknown, options?: { model?: string; systemPrompt?: string }) => {
      return handleCall({ method: "resumeSession", sessionId, model: options?.model, systemPrompt: options?.systemPrompt });
    }),
    forkSession: mock((sessionId: string, _resultType: unknown, options?: { model?: string; systemPrompt?: string }) => {
      return handleCall({ method: "forkSession", sessionId, model: options?.model, systemPrompt: options?.systemPrompt });
    }),
    calls,
    processes,
  } as unknown as Claude & { calls: CallInfo[]; processes: ClaudeProcess<unknown>[]; newSession: ReturnType<typeof mock>; resumeSession: ReturnType<typeof mock>; forkSession: ReturnType<typeof mock> };
  return claude;
}

function makeOrchestrator(claude: Claude, extraConfig?: Partial<OrchestratorConfig>) {
  const responses: OrchestratorResponse[] = [];
  const onResponse = mock(async (r: OrchestratorResponse) => { responses.push(r); });
  const orch = new Orchestrator({
    workspace: TEST_WORKSPACE,
    model: "sonnet",
    timeZone: "UTC",
    settingsDir: tmpSettingsDir,
    onResponse,
    claude,
    healthCheckInterval: 0,
    ...extraConfig,
  });
  activeOrchestrators.push(orch);
  return { orch, responses, onResponse };
}

async function waitForProcessing(ms = 50) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Get all prompts sent to all processes */
function sentPrompts(claude: { processes: ClaudeProcess<unknown>[] }): string[] {
  return claude.processes.flatMap((p) =>
    (p.send as ReturnType<typeof mock>).mock.calls.map((c: unknown[]) => c[0] as string),
  );
}

describe("Orchestrator", () => {
  describe("prompt building", () => {
    it("builds user prompt as-is", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      expect(sentPrompts(claude)[0]).toContain('type="user-message"');
      expect(sentPrompts(claude)[0]).toContain("<text>hello</text>");
    });

    it("prepends file references for user requests", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("check this", ["/tmp/photo.jpg", "/tmp/doc.pdf"]);
      await waitForProcessing();

      expect(sentPrompts(claude)[0]).toContain('<file path="/tmp/photo.jpg" />');
      expect(sentPrompts(claude)[0]).toContain('<file path="/tmp/doc.pdf" />');
      expect(sentPrompts(claude)[0]).toContain("<text>check this</text>");
    });

    it("sends only file references when message is empty", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("", ["/tmp/photo.jpg"]);
      await waitForProcessing();

      expect(sentPrompts(claude)[0]).toContain('<file path="/tmp/photo.jpg" />');
      expect(sentPrompts(claude)[0]).not.toContain("<text>");
    });

    it("builds button click prompt", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleButton("Yes");
      await waitForProcessing();

      expect(sentPrompts(claude)[0]).toContain('<button>Yes</button>');
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
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        const { process, reject } = pendingProcess("err-sid");
        // Auto-reject when send is called
        const origSend = process.send;
        (process as any).send = mock(async (prompt: string) => {
          const p = (origSend as Function).call(process, prompt);
          reject(new QueryProcessError(1, "spawn failed"));
          return p;
        });
        return process;
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toContain("[Error]");
      expect(responses[0].message).toContain("spawn failed");
    });

    it("maps QueryParseError to json-parse-failed response", async () => {
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        const proc = autoProcess(null, "err-sid");
        (proc as any).send = mock(async () => { throw new QueryParseError("not json"); });
        return proc;
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hi");
      await waitForProcessing();

      expect(responses[0].message).toContain("[JSON Error]");
    });

    it("reports error when resume fails", async () => {
      saveSessions({ mainSessions: { admin: "old-session" } }, tmpSettingsDir);
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        const proc = autoProcess(null, "old-session");
        (proc as any).send = mock(async () => { throw new QueryProcessError(1, "session not found"); });
        return proc;
      });
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
      saveSessions({ mainSessions: { admin: "existing-session" } }, tmpSettingsDir);
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

    it("reuses main process for second message (no new factory call)", async () => {
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("first");
      await waitForProcessing();
      orch.handleMessage("second");
      await waitForProcessing();

      // Only one factory call — process is reused
      expect(claude.calls).toHaveLength(1);
      // But the process was sent to twice
      const mainProc = claude.processes[0];
      expect((mainProc.send as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
    });

    it("background-agent forks from main session", async () => {
      saveSessions({ mainSessions: { admin: "main-session" } }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      orch.handleBackgroundCommand("do work");
      await waitForProcessing();

      // First call: resumeSession for main, second: forkSession for background
      expect(claude.calls[1].method).toBe("forkSession");
    });
  });

  describe("non-blocking handler", () => {
    it("handler returns immediately, result delivered by completion handler", async () => {
      const { process: mainProc, resolve } = pendingProcess("main-sid");
      const claude = mockClaude(() => mainProc);
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      // Handler returned but no response yet (send still pending)
      expect(responses).toHaveLength(0);

      // Query completes — completion handler delivers
      resolve({ action: "send", message: "done!", actionReason: "ok" });
      await waitForProcessing();

      expect(responses[0].message).toBe("done!");
    });

    it("second message processes while first is still running", async () => {
      const { process: p1, resolve: resolve1 } = pendingProcess("q1-sid");
      const p2 = autoProcess({ action: "send", message: "second done", actionReason: "ok" }, "q2-sid");

      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount === 1) return p1;
        return p2;
      });
      // waitThreshold=0 so second message demotes immediately
      const { orch, responses } = makeOrchestrator(claude, { waitThreshold: 0 });

      orch.handleMessage("first");
      await waitForProcessing();

      // First process is busy, handler returned
      expect(callCount).toBe(1);

      orch.handleMessage("second");
      await waitForProcessing();

      // Second message caused a fork+demote, second process started
      expect(callCount).toBe(2);
      const secondCall = claude.calls[1];
      expect(secondCall.method).toBe("forkSession");
      expect(sentPrompts(claude)[1]).toContain("<backgrounded-event");
      expect(sentPrompts(claude)[1]).toContain("<text>second</text>");

      // Resolve first (backgrounded) — feeds back as background result
      resolve1({ action: "send", message: "first done", actionReason: "ok" });
      await waitForProcessing(100);

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("second done");
    });

    it("waits for main to finish when within threshold, then processes next message", async () => {
      const { process: p1, resolve: resolve1 } = pendingProcess("main-sid");

      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        return p1; // Same process reused
      });
      const { orch, responses } = makeOrchestrator(claude);

      // First message — handler returns immediately
      orch.handleMessage("slow task");
      await waitForProcessing();
      expect(callCount).toBe(1);

      // Second message — main is running, within threshold, handler blocks
      orch.handleMessage("follow up");
      await waitForProcessing(10);

      // Still blocked, only 1 process
      expect(callCount).toBe(1);

      // First send finishes — completion handler delivers, then handler unblocks
      resolve1({ action: "send", message: "slow done", actionReason: "ok" });
      await waitForProcessing(100);

      // Process was reused for second message (same process, second send)
      const mainProc = claude.processes[0];
      expect((mainProc.send as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
      const messages = responses.map((r) => r.message);
      expect(messages).toContain("slow done");
    });

    it("demotes after wait timeout when main does not finish in time", async () => {
      const { process: p1 } = pendingProcess("main-sid");

      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount === 1) return p1;
        return autoProcess({ action: "send", message: "forked result", actionReason: "ok" }, "new-main");
      });
      // Short threshold so we don't wait long
      const { orch, responses } = makeOrchestrator(claude, { waitThreshold: 10 });

      orch.handleMessage("slow task");
      await waitForProcessing();

      orch.handleMessage("follow up");
      await waitForProcessing(200);

      expect(callCount).toBe(2);
      expect(sentPrompts(claude)[1]).toContain("<backgrounded-event");
      expect(sentPrompts(claude)[1]).toContain("follow up");
      expect(responses.map((r) => r.message)).toContain("forked result");
    });

    it("delivers result with error when session not in runningSessions", async () => {
      saveSessions({ mainSessions: { admin: "main-session" } }, tmpSettingsDir);
      const { process: mainProc, resolve } = pendingProcess("main-session");
      const claude = mockClaude(() => mainProc);
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      // Kill the session (removes from runningSessions)
      await orch.handleKill("main-session");
      await waitForProcessing();

      // Query completes after kill — should still deliver (with error log)
      resolve({ action: "send", message: "late result", actionReason: "ok" });
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

      expect(sentPrompts(claude)[0]).toContain('<button>Yes</button>');
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
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount <= 2) {
          // First: main process, second: background agent fork
          return autoProcess(
            callCount === 1
              ? {
                  action: "send",
                  message: "Starting research",
                  actionReason: "needs research",
                  backgroundAgents: [{ name: "research", prompt: "research this" }],
                }
              : { action: "send", message: "research result", actionReason: "done" },
            `sid-${callCount}`,
          );
        }
        // Third: main session gets background-agent-result
        return autoProcess({ action: "send", message: "relayed", actionReason: "ok" }, `sid-${callCount}`);
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      const messages = responses.map((r) => r.message);
      expect(messages).toContain("Starting research");
      expect(messages).toContain('Background agent "research" started.');

      await waitForProcessing(100);
    });
  });

  describe("cron routing", () => {
    it("cron always forks as background, never goes through queue", async () => {
      saveSessions({ mainSessions: { admin: "main-session" } }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude);

      orch.handleCron("daily-check", "Check for updates", "haiku");
      await waitForProcessing();

      expect(claude.calls[0].method).toBe("forkSession");
      expect(sentPrompts(claude)[0]).toContain('<schedule name="daily-check" />');
      expect(sentPrompts(claude)[0]).toContain("<text>Check for updates</text>");
      expect(claude.calls[0].model).toBe("haiku");
    });

    it("cron uses config model when none specified", async () => {
      saveSessions({ mainSessions: { admin: "main-session" } }, tmpSettingsDir);
      const claude = mockClaude({ action: "send", message: "ok", actionReason: "ok" });
      const { orch } = makeOrchestrator(claude, { model: "sonnet" });

      orch.handleCron("basic", "check");
      await waitForProcessing();

      expect(claude.calls[0].model).toBe("sonnet");
    });

    it("cron result feeds back into main session", async () => {
      saveSessions({ mainSessions: { admin: "main-session" } }, tmpSettingsDir);
      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        return autoProcess({ action: "send", message: `call ${callCount}`, actionReason: "ok" }, `sid-${callCount}`);
      });
      const { orch } = makeOrchestrator(claude);

      orch.handleCron("check", "any updates?");
      await waitForProcessing(150);

      expect(callCount).toBeGreaterThanOrEqual(2); // 1 cron bg + 1 bg result fed back
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
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        const { process } = pendingProcess(`bg-${Date.now()}`);
        return process;
      });
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
      expect((detailBtn as { data: string }).data).toMatch(/^detail:/);
      expect((detailBtn as { text: string }).text).toContain("long-task");
      expect(listResponse.buttons![1]).toEqual({ text: "Dismiss", data: "_dismiss" });
    });

    it("marks main session in listing", async () => {
      const { process } = pendingProcess("main-sid");
      const claude = mockClaude(() => process);
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
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount === 1) {
          const { process } = pendingProcess("bg-sid");
          return process;
        }
        return autoProcess("Working on it, 50% done.", "peek-session");
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
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount === 1) {
          const { process } = pendingProcess("bg-sid");
          return process;
        }
        const proc = autoProcess(null, "peek-err");
        (proc as any).send = mock(async () => { throw new Error("connection lost"); });
        return proc;
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
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        const { process } = pendingProcess("bg-sid");
        return process;
      });
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
      expect(detailResponse.message).toContain("sonnet");
      expect(detailResponse.message).toContain("Status: running");
      expect(detailResponse.buttons).toHaveLength(3);
      expect(detailResponse.buttons![0]).toEqual({ text: "Peek", data: `peek:${sessionId}` });
      expect(detailResponse.buttons![1]).toEqual({ text: "Kill", data: `kill:${sessionId}` });
      expect(detailResponse.buttons![2]).toEqual({ text: "Dismiss", data: "_dismiss" });
    });

    it("truncates prompt at 300 chars", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const longPrompt = "a".repeat(500);
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        const { process } = pendingProcess("bg-sid");
        return process;
      });
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
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        const { process } = pendingProcess("bg-sid");
        return process;
      });
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

    it("shows clean prompt text for main sessions, not XML wrapper", async () => {
      const { process } = pendingProcess("main-sid");
      const claude = mockClaude(() => process);
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("I want to visit my parents at their house");
      await waitForProcessing();

      orch.handleSessions();
      await waitForProcessing();
      const listResponse = responses[responses.length - 1];
      const detailBtn = listResponse.buttons![0] as { text: string; data: string };
      const sessionId = detailBtn.data.slice(7);

      orch.handleDetail(sessionId);
      await waitForProcessing();

      const detailResponse = responses[responses.length - 1];
      expect(detailResponse.message).toContain("I want to visit my parents");
      expect(detailResponse.message).not.toContain("<event");
      expect(detailResponse.message).not.toContain("<text>");
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
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc } = pendingProcess("bg-sid");
      const claude = mockClaude((): ClaudeProcess<unknown> => bgProc);
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

      expect(bgProc.kill).toHaveBeenCalled();
      const killResponse = responses[responses.length - 1];
      expect(killResponse.message).toContain("Killed");
      expect(killResponse.message).toContain("research-pricing");

      orch.handleSessions();
      await waitForProcessing();
      expect(responses[responses.length - 1].message).toBe("No running sessions.");
    });

    it("does not feed error back to queue after kill", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc, reject: rejectBg } = pendingProcess("bg-sid");
      const claude = mockClaude((): ClaudeProcess<unknown> => bgProc);
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

      rejectBg(new Error("process killed"));
      await waitForProcessing(100);

      const newResponses = responses.slice(countAfterKill);
      expect(newResponses.every((r) => !r.message.includes("[Error]"))).toBe(true);
    });
  });

  describe("handleBackgroundCommand", () => {
    it("spawns background agent and sends started message", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        const { process } = pendingProcess("bg-sid");
        return process;
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("research pricing");
      await waitForProcessing();

      expect(responses[0].message).toBe('Background agent "research-pricing" started.');
      expect(claude.calls).toHaveLength(1);
    });
  });

  describe("background management", () => {
    it("spawns background agent and feeds result back to queue", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc, resolve: resolveBg } = pendingProcess("bg-sid");

      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount === 1) return bgProc;
        // Main session processes the background-agent-result
        return autoProcess({ action: "send", message: "bg result processed", actionReason: "ok" }, `sid-${callCount}`);
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("do something");
      await waitForProcessing();

      expect(responses[0].message).toContain('started.');

      resolveBg({ action: "send", message: "done!", actionReason: "completed" });
      await waitForProcessing(100);

      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it("passes action and actionReason through result XML for silent background agent", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc, resolve: resolveBg } = pendingProcess("bg-sid");

      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount === 1) return bgProc;
        return autoProcess({ action: "silent", actionReason: "nothing to report" }, `sid-${callCount}`);
      });
      const { orch } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("check something");
      await waitForProcessing();

      resolveBg({ action: "silent", actionReason: "no new results" });
      await waitForProcessing(100);

      const prompts = sentPrompts(claude);
      const bgResultPrompt = prompts.find((p: string) => p?.includes("background-agent-result"));
      expect(bgResultPrompt).toBeDefined();
      expect(bgResultPrompt).toContain('action="silent"');
      expect(bgResultPrompt).toContain('action-reason="no new results"');
      expect(bgResultPrompt).not.toContain("<text>");
    });

    it("feeds error back to queue on spawn failure", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc, reject: rejectBg } = pendingProcess("bg-sid");

      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount === 1) return bgProc;
        return autoProcess({ action: "send", message: "error processed", actionReason: "ok" }, `sid-${callCount}`);
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleBackgroundCommand("failing task");
      await waitForProcessing();

      rejectBg(new Error("spawn failed"));
      await waitForProcessing(100);

      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(responses[responses.length - 1].message).toBe("error processed");
    });
  });

  describe("health checks", () => {
    it("runs health check after interval and reports finished agent", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc } = pendingProcess("bg-sid");

      let callCount = 0;
      const claude = mockClaude((_info: CallInfo): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount === 1) return bgProc; // background agent spawn
        if (sentPrompts({ processes: (claude as any).processes }).some((p: string) => p?.includes("health-check")) || callCount === 2) {
          // Health check fork
          return autoProcess({
            finished: true,
            output: { action: "send", message: "task complete", actionReason: "done" },
          }, "hc-sid");
        }
        // Main session processes the background-agent-result
        return autoProcess({ action: "send", message: "relayed", actionReason: "ok" }, `sid-${callCount}`);
      });

      const { orch } = makeOrchestrator(claude, {
        healthCheckInterval: 50,
        healthCheckTimeout: 5000,
      });

      orch.handleBackgroundCommand("long task");
      await waitForProcessing(200);

      // Health check should have fired
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(claude.calls.some((c: CallInfo) => c.model === "haiku")).toBe(true);
    });

    it("reports progress and schedules next check when not finished", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc } = pendingProcess("bg-sid");

      let hcCount = 0;
      const claude = mockClaude((info: CallInfo): ClaudeProcess<unknown> => {
        if (info.model === "haiku") {
          hcCount++;
          return autoProcess({ finished: false, progress: "still working" }, `hc-sid-${hcCount}`);
        }
        if (hcCount > 0) {
          // Main session processes progress
          return autoProcess({ action: "silent", message: "ok", actionReason: "progress" }, `main-sid-${hcCount}`);
        }
        return bgProc; // background agent spawn
      });

      const { orch } = makeOrchestrator(claude, {
        healthCheckInterval: 50,
        healthCheckTimeout: 5000,
      });

      orch.handleBackgroundCommand("long task");
      // Wait for two health check cycles
      await waitForProcessing(250);

      expect(hcCount).toBeGreaterThanOrEqual(2);

      // Kill session to stop the health check loop
      await orch.handleKill("bg-sid");
    });

    it("kills unresponsive agent on health check timeout", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc } = pendingProcess("bg-sid");

      const claude = mockClaude((info: CallInfo): ClaudeProcess<unknown> => {
        if (info.model === "haiku") {
          // Never resolves — simulates unresponsive health check
          const { process } = pendingProcess("hc-sid");
          return process;
        }
        return bgProc;
      });

      const { orch, responses } = makeOrchestrator(claude, {
        healthCheckInterval: 30,
        healthCheckTimeout: 60,
      });

      orch.handleBackgroundCommand("stuck task");
      await waitForProcessing(200);

      const killMsg = responses.find((r) => r.message.includes("unresponsive"));
      expect(killMsg).toBeDefined();
    });

    it("does not run health checks when interval is 0", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc } = pendingProcess("bg-sid");

      const claude = mockClaude((): ClaudeProcess<unknown> => bgProc);
      const { orch } = makeOrchestrator(claude, { healthCheckInterval: 0 });

      orch.handleBackgroundCommand("some task");
      await waitForProcessing(100);

      // Only the spawn call, no health check fork
      expect(claude.calls).toHaveLength(1);
    });

    it("clears health check timer when session is killed", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc } = pendingProcess("bg-sid");

      let hcCount = 0;
      const claude = mockClaude((info: CallInfo): ClaudeProcess<unknown> => {
        if (info.model === "haiku") hcCount++;
        return bgProc;
      });

      const { orch } = makeOrchestrator(claude, { healthCheckInterval: 100 });

      orch.handleBackgroundCommand("killable task");
      await waitForProcessing();

      // Get the session ID and kill it before health check fires
      orch.handleKill("bg-sid");
      await waitForProcessing(200);

      expect(hcCount).toBe(0);
    });

    it("stops health check if session completes organically before timer", async () => {
      saveSessions({ mainSessions: { admin: "test-session" } }, tmpSettingsDir);
      const { process: bgProc, resolve: resolveBg } = pendingProcess("bg-sid");

      let hcCount = 0;
      let callCount = 0;
      const claude = mockClaude((info: CallInfo): ClaudeProcess<unknown> => {
        callCount++;
        if (info.model === "haiku") { hcCount++; const { process } = pendingProcess(`hc-sid-${hcCount}`); return process; }
        if (callCount === 1) return bgProc;
        return autoProcess({ action: "send", message: "processed", actionReason: "ok" }, `sid-${callCount}`);
      });

      const { orch } = makeOrchestrator(claude, { healthCheckInterval: 200 });

      orch.handleBackgroundCommand("fast task");
      await waitForProcessing();

      // Complete before health check fires
      resolveBg({ action: "send", message: "done", actionReason: "done" });
      await waitForProcessing(350);

      expect(hcCount).toBe(0);
    });
  });

  describe("handleClear", () => {
    it("kills main process and sends confirmation", async () => {
      const { process: mainProc } = pendingProcess("main-sid");
      const claude = mockClaude(() => mainProc);
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();

      await orch.handleClear();
      await waitForProcessing();

      expect(mainProc.kill).toHaveBeenCalled();
      expect(responses.some((r) => r.message === "Session cleared.")).toBe(true);
    });

    it("creates new session (not resume) for next message after clear", async () => {
      const { process: p1, resolve: r1 } = pendingProcess("first-sid");
      let callCount = 0;
      const claude = mockClaude((): ClaudeProcess<unknown> => {
        callCount++;
        if (callCount === 1) return p1;
        return autoProcess({ action: "send", message: "after clear", actionReason: "ok" }, "second-sid");
      });
      const { orch, responses } = makeOrchestrator(claude);

      orch.handleMessage("hello");
      await waitForProcessing();
      r1({ action: "send", message: "first", actionReason: "ok" });
      await waitForProcessing();

      await orch.handleClear();
      await waitForProcessing();

      orch.handleMessage("hi again");
      await waitForProcessing();

      expect(callCount).toBe(2);
      // After clear, should use newSession (not resumeSession)
      expect(claude.calls[1].method).toBe("newSession");
      expect(responses.some((r) => r.message === "after clear")).toBe(true);
    });
  });

  describe("onResponse error handling", () => {
    it("logs error and does not throw when onResponse callback fails", async () => {
      const claude = mockClaude({ action: "send", message: "hello", actionReason: "ok" });
      const failingOnResponse = mock(async (_r: OrchestratorResponse) => { throw new Error("send failed"); });
      const orch = new Orchestrator({
        workspace: TEST_WORKSPACE,
        model: "sonnet",
        timeZone: "UTC",
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
