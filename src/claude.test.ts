import { afterEach, describe, expect, it, mock } from "bun:test";
import { z } from "zod/v4";
import { Claude, ClaudeProcess, QueryProcessError, QueryValidationError, type RawProcess } from "./claude";

const encoder = new TextEncoder();

function resultEnvelope(opts: { structuredOutput?: unknown; result?: string; sessionId?: string; durationMs?: number; costUsd?: number }): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: opts.durationMs ?? 1234,
    total_cost_usd: opts.costUsd ?? 0.05,
    result: opts.result ?? "",
    session_id: opts.sessionId ?? "server-sid",
    structured_output: opts.structuredOutput,
  });
}

function systemEvent(): string {
  return JSON.stringify({ type: "system", subtype: "init", session_id: "sid", tools: [] });
}

function assistantEvent(text = "hello"): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

/** All mock procs created during a test — cleaned up in afterEach */
const activeMocks: Array<{ closeStdout: () => void; resolveExited: (code: number) => void }> = [];

/** Creates a controllable mock process for ClaudeProcess tests */
function createMockProc(): {
  proc: RawProcess;
  emitLine: (line: string) => void;
  closeStdout: () => void;
  resolveExited: (code: number) => void;
  stdin: { write: ReturnType<typeof mock>; flush: ReturnType<typeof mock>; end: ReturnType<typeof mock> };
} {
  let stdoutController: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) { stdoutController = c; },
  });

  let stderrController: ReadableStreamDefaultController<Uint8Array>;
  const stderr = new ReadableStream<Uint8Array>({
    start(c) { stderrController = c; },
  });

  let resolveExited: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExited = resolve; });

  const stdin = {
    write: mock(() => {}),
    flush: mock(() => {}),
    end: mock(() => {}),
  };

  const proc: RawProcess = {
    stdin,
    stdout,
    stderr,
    exited,
    kill: mock(() => {}),
  };

  const closeStdout = () => {
    try { stdoutController.close(); } catch { /* already closed */ }
    try { stderrController.close(); } catch { /* already closed */ }
  };

  const handle = { closeStdout, resolveExited: resolveExited! };
  activeMocks.push(handle);

  return {
    proc,
    emitLine: (line: string) => stdoutController.enqueue(encoder.encode(`${line}\n`)),
    closeStdout,
    resolveExited: resolveExited!,
    stdin,
  };
}

const originalSpawn = Bun.spawn;

afterEach(() => {
  Bun.spawn = originalSpawn;
  // Close all streams and resolve exited promises to free readers
  for (const m of activeMocks.splice(0)) {
    m.closeStdout();
    m.resolveExited(0);
  }
});

const TEST_WORKSPACE = "/tmp/claude2-test";

function makeClaude(config?: { model?: string; systemPrompt?: string }) {
  return new Claude({ workspace: TEST_WORKSPACE, ...config });
}

const textResult = { type: "text" } as const;

function objectResult(schema?: z.ZodType) {
  return { type: "object" as const, schema: schema ?? z.any() };
}

function spawnArgs(): string[] {
  return (Bun.spawn as any).mock.calls[0][0] as string[];
}

function spawnOpts(): Record<string, unknown> {
  return (Bun.spawn as any).mock.calls[0][1] as Record<string, unknown>;
}

/** Helper to mock Bun.spawn and return a controllable mock process */
function mockSpawn() {
  const mockProc = createMockProc();
  (Bun as any).spawn = mock(() => mockProc.proc);
  return mockProc;
}

describe("ClaudeProcess", () => {
  describe("send", () => {
    it("writes NDJSON to stdin and resolves on result event", async () => {
      const { proc, emitLine, stdin } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const promise = cp.send("hello");

      emitLine(systemEvent());
      emitLine(assistantEvent());
      emitLine(resultEnvelope({ result: "hello world" }));

      const { value } = await promise;
      expect(value).toBe("hello world");
      expect(stdin.write).toHaveBeenCalledTimes(1);
      const written = stdin.write.mock.calls[0][0] as string;
      const parsed = JSON.parse(written);
      expect(parsed.type).toBe("user");
      expect(parsed.message.content).toBe("hello");
      expect(stdin.flush).toHaveBeenCalledTimes(1);
    });

    it("returns parsed value for object resultType", async () => {
      const schema = z.object({ count: z.number() });
      const { proc, emitLine } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", objectResult(schema));

      const promise = cp.send("hi");
      emitLine(resultEnvelope({ structuredOutput: { count: 5 } }));

      const { value } = await promise;
      expect(value).toEqual({ count: 5 });
    });

    it("skips non-result events", async () => {
      const { proc, emitLine } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const promise = cp.send("hi");
      emitLine(systemEvent());
      emitLine(assistantEvent());
      emitLine(JSON.stringify({ type: "rate_limit_event" }));
      emitLine(resultEnvelope({ result: "done" }));

      const { value } = await promise;
      expect(value).toBe("done");
    });

    it("skips non-JSON lines", async () => {
      const { proc, emitLine } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const promise = cp.send("hi");
      emitLine("not json at all");
      emitLine(resultEnvelope({ result: "ok" }));

      const { value } = await promise;
      expect(value).toBe("ok");
    });

    it("returns duration and cost from result envelope", async () => {
      const { proc, emitLine } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const promise = cp.send("hi");
      emitLine(resultEnvelope({ result: "ok", durationMs: 2500, costUsd: 0.123 }));

      const { duration, cost } = await promise;
      expect(duration).toBe("2.5s");
      expect(cost).toBe("$0.1230");
    });

    it("returns sessionId from result envelope", async () => {
      const { proc, emitLine } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const promise = cp.send("hi");
      emitLine(resultEnvelope({ result: "ok", sessionId: "server-returned-sid" }));

      const { sessionId } = await promise;
      expect(sessionId).toBe("server-returned-sid");
    });

    it("transitions state: idle -> busy -> idle", async () => {
      const { proc, emitLine } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      expect(cp.state).toBe("idle");
      const promise = cp.send("hi");
      // After send starts, state is busy
      expect(cp.state).toBe("busy");

      emitLine(resultEnvelope({ result: "ok" }));
      await promise;
      expect(cp.state).toBe("idle");
    });

    it("throws when called while busy", async () => {
      const { proc } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const pending = cp.send("first"); // starts, goes busy
      pending.catch(() => {}); // Ignore — testing the second send
      expect(() => cp.send("second")).toThrow("Cannot send: process is busy");
    });

    it("throws when called while dead", async () => {
      const { proc, resolveExited } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      resolveExited(0);
      await cp.kill();
      expect(() => cp.send("hi")).toThrow("Cannot send: process is dead");
    });

    it("supports multiple sequential sends", async () => {
      const { proc, emitLine } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const p1 = cp.send("first");
      emitLine(resultEnvelope({ result: "response 1" }));
      const r1 = await p1;
      expect(r1.value).toBe("response 1");

      const p2 = cp.send("second");
      emitLine(resultEnvelope({ result: "response 2" }));
      const r2 = await p2;
      expect(r2.value).toBe("response 2");
    });

    it("rejects with QueryProcessError when process exits mid-send", async () => {
      const { proc, closeStdout, resolveExited } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const promise = cp.send("hi");
      closeStdout();
      resolveExited(1);

      try {
        await promise;
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(QueryProcessError);
        expect((err as QueryProcessError).exitCode).toBe(1);
      }
      expect(cp.state).toBe("dead");
    });

    it("rejects with QueryProcessError when stdin write fails", async () => {
      const { proc, stdin } = createMockProc();
      stdin.write.mockImplementation(() => { throw new Error("broken pipe"); });
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      try {
        await cp.send("hi");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(QueryProcessError);
        expect((err as QueryProcessError).stderr).toContain("broken pipe");
      }
      expect(cp.state).toBe("dead");
    });

    it("rejects with QueryValidationError when schema.parse throws", async () => {
      const schema = z.object({ count: z.number() }).strict();
      const { proc, emitLine } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", objectResult(schema));

      const promise = cp.send("hi");
      emitLine(resultEnvelope({ structuredOutput: { bad: true } }));

      try {
        await promise;
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(QueryValidationError);
        expect((err as QueryValidationError).raw).toEqual({ bad: true });
      }
    });
  });

  describe("kill", () => {
    it("kills the process and transitions to dead", async () => {
      const { proc, resolveExited } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const killPromise = cp.kill();
      resolveExited(0);
      await killPromise;

      expect(cp.state).toBe("dead");
      expect(proc.kill).toHaveBeenCalled();
    });

    it("is idempotent when already dead", async () => {
      const { proc, resolveExited } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      const p1 = cp.kill();
      resolveExited(0);
      await p1;

      // Second kill should be a no-op
      await cp.kill();
      expect(proc.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe("unexpected exit", () => {
    it("sets state to dead when process exits while idle", async () => {
      const { proc, resolveExited } = createMockProc();
      const cp = new ClaudeProcess(proc, "test-sid", textResult);

      expect(cp.state).toBe("idle");
      resolveExited(1);
      // Give microtask a chance to run
      await new Promise((r) => setTimeout(r, 10));
      expect(cp.state).toBe("dead");
    });
  });
});

describe("Claude factory", () => {
  describe("newSession", () => {
    it("spawns with --session-id and stream-json flags", () => {
      mockSpawn();
      const claude = makeClaude();
      const process = claude.newSession(textResult);

      expect(process.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const args = spawnArgs();
      expect(args).toContain("--session-id");
      expect(args).toContain(process.sessionId);
      expect(args).toContain("--input-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--output-format");
      expect(args).toContain("--verbose");
      expect(args).not.toContain("--resume");
      expect(args).not.toContain("--fork-session");
    });
  });

  describe("resumeSession", () => {
    it("spawns with --resume and the provided sessionId", () => {
      mockSpawn();
      const claude = makeClaude();
      const process = claude.resumeSession("existing-sid", textResult);

      expect(process.sessionId).toBe("existing-sid");
      const args = spawnArgs();
      expect(args).toContain("--resume");
      expect(args).toContain("existing-sid");
      expect(args).not.toContain("--session-id");
      expect(args).not.toContain("--fork-session");
    });
  });

  describe("forkSession", () => {
    it("spawns with --resume parent, --fork-session, and new --session-id", () => {
      mockSpawn();
      const claude = makeClaude();
      const process = claude.forkSession("parent-sid", textResult);

      expect(process.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(process.sessionId).not.toBe("parent-sid");
      const args = spawnArgs();
      expect(args).toContain("--resume");
      expect(args).toContain("parent-sid");
      expect(args).toContain("--fork-session");
      expect(args).toContain("--session-id");
      expect(args).toContain(process.sessionId);
    });
  });

  describe("options", () => {
    it("uses constructor model as default", () => {
      mockSpawn();
      const claude = makeClaude({ model: "sonnet" });
      claude.newSession(textResult);
      expect(spawnArgs()).toContain("sonnet");
    });

    it("per-call model overrides constructor model", () => {
      mockSpawn();
      const claude = makeClaude({ model: "sonnet" });
      claude.newSession(textResult, { model: "haiku" });
      const args = spawnArgs();
      expect(args).toContain("haiku");
      expect(args).not.toContain("sonnet");
    });

    it("uses constructor systemPrompt as default", () => {
      mockSpawn();
      const claude = makeClaude({ systemPrompt: "Be helpful." });
      claude.newSession(textResult);
      const args = spawnArgs();
      expect(args).toContain("--append-system-prompt");
      expect(args).toContain("Be helpful.");
    });

    it("per-call systemPrompt overrides constructor systemPrompt", () => {
      mockSpawn();
      const claude = makeClaude({ systemPrompt: "Be helpful." });
      claude.newSession(textResult, { systemPrompt: "Be brief." });
      const args = spawnArgs();
      expect(args).toContain("Be brief.");
      expect(args).not.toContain("Be helpful.");
    });

    it("omits --model when none specified", () => {
      mockSpawn();
      const claude = makeClaude();
      claude.newSession(textResult);
      expect(spawnArgs()).not.toContain("--model");
    });

    it("omits --append-system-prompt when none specified", () => {
      mockSpawn();
      const claude = makeClaude();
      claude.newSession(textResult);
      expect(spawnArgs()).not.toContain("--append-system-prompt");
    });
  });

  describe("resultType", () => {
    it("omits --json-schema for text resultType", () => {
      mockSpawn();
      const claude = makeClaude();
      claude.newSession(textResult);
      expect(spawnArgs()).not.toContain("--json-schema");
    });

    it("passes --json-schema for object resultType", () => {
      mockSpawn();
      const claude = makeClaude();
      claude.newSession(objectResult());
      expect(spawnArgs()).toContain("--json-schema");
    });
  });

  describe("environment", () => {
    it("strips CLAUDECODE env var", () => {
      mockSpawn();
      const claude = makeClaude();
      claude.newSession(textResult);
      const opts = spawnOpts();
      expect(opts.env).not.toHaveProperty("CLAUDECODE");
    });

    it("spawns in the configured workspace directory", () => {
      mockSpawn();
      const claude = makeClaude();
      claude.newSession(textResult);
      expect(spawnOpts().cwd).toBe(TEST_WORKSPACE);
    });

    it("includes disallowedTools in CLI args", () => {
      mockSpawn();
      const claude = makeClaude();
      claude.newSession(textResult);
      const args = spawnArgs();
      expect(args).toContain("--disallowedTools");
      expect(args).toContain("CronList,CronDelete,CronCreate,AskUserQuestion");
    });

    it("spawns with stdin: pipe, stdout: pipe, stderr: pipe", () => {
      mockSpawn();
      const claude = makeClaude();
      claude.newSession(textResult);
      const opts = spawnOpts();
      expect(opts.stdin).toBe("pipe");
      expect(opts.stdout).toBe("pipe");
      expect(opts.stderr).toBe("pipe");
    });
  });
});
