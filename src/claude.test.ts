import { describe, it, expect, mock, afterEach } from "bun:test";
import { runClaude, newSessionId, type ClaudeResponse } from "./claude";

function jsonResponse(action: "send" | "silent", message: string, reason: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    total_cost_usd: 0.05,
    result: "",
    structured_output: { action, message, reason },
  });
}

const originalSpawn = Bun.spawn;

afterEach(() => {
  Bun.spawn = originalSpawn;
});

function mockSpawn(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  rejectExited?: boolean;
}) {
  const proc = {
    stdout: new Response(opts.stdout ?? "").body,
    stderr: new Response(opts.stderr ?? "").body,
    exited: opts.rejectExited
      ? Promise.reject(new Error("killed"))
      : Promise.resolve(opts.exitCode ?? 0),
    kill: mock(() => {}),
  };

  Bun.spawn = mock((() => proc) as any);
  return proc;
}

const TEST_WORKSPACE = "/tmp/macroclaw-test-workspace";

// Use unique session IDs per test to avoid knownSessions leaking between tests
let testCounter = 0;
function uniqueSession() {
  return `test-session-${++testCounter}`;
}

describe("runClaude", () => {
  it("uses --session-id on first call", async () => {
    const sid = uniqueSession();
    mockSpawn({ stdout: jsonResponse("send", "Hello", "user message"), exitCode: 0 });
    const result = await runClaude("test message", sid, undefined, TEST_WORKSPACE);
    expect(result).toEqual({ action: "send", message: "Hello", reason: "user message" });
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "-p", "--session-id", sid, "--output-format", "json", "--json-schema"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE, stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("uses --resume on subsequent calls", async () => {
    const sid = uniqueSession();
    // First call to mark session as known
    mockSpawn({ stdout: jsonResponse("send", "first", "ok"), exitCode: 0 });
    await runClaude("msg1", sid, undefined, TEST_WORKSPACE);

    // Second call should use --resume
    mockSpawn({ stdout: jsonResponse("send", "second", "ok"), exitCode: 0 });
    await runClaude("msg2", sid, undefined, TEST_WORKSPACE);
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "-p", "--resume", sid, "--output-format", "json", "--json-schema"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE, stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("retries with --resume when session already exists", async () => {
    const sid = uniqueSession();
    let callCount = 0;
    Bun.spawn = mock((() => {
      callCount++;
      if (callCount === 1) {
        return {
          stdout: new Response("").body,
          stderr: new Response("Session ID is already in use").body,
          exited: Promise.resolve(1),
          kill: mock(() => {}),
        };
      }
      return {
        stdout: new Response(jsonResponse("send", "retried ok", "ok")).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    }) as any);

    const result = await runClaude("msg", sid, undefined, TEST_WORKSPACE);
    expect(result).toEqual({ action: "send", message: "retried ok", reason: "ok" });
    expect(callCount).toBe(2);
  });

  it("passes model flag when provided", async () => {
    const sid = uniqueSession();
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    await runClaude("msg", sid, "haiku", TEST_WORKSPACE);
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "-p", "--session-id", sid, "--output-format", "json", "--json-schema", "--model", "haiku", "msg"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE, stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("passes --append-system-prompt when systemPrompt is provided", async () => {
    const sid = uniqueSession();
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    await runClaude("msg", sid, undefined, TEST_WORKSPACE, "You are a background agent.");
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["--append-system-prompt", "You are a background agent.", "msg"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE }),
    );
  });

  it("omits --append-system-prompt when systemPrompt is undefined", async () => {
    const sid = uniqueSession();
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    await runClaude("msg", sid, undefined, TEST_WORKSPACE);
    const args = (Bun.spawn as any).mock.calls[0][0] as string[];
    expect(args).not.toContain("--append-system-prompt");
  });

  it("returns error response on non-zero exit", async () => {
    const sid = uniqueSession();
    mockSpawn({ stderr: "something went wrong", exitCode: 1 });
    const result = await runClaude("bad message", sid, undefined, TEST_WORKSPACE);
    expect(result.action).toBe("send");
    expect(result.message).toContain("[Error]");
    expect(result.message).toContain("something went wrong");
    expect(result.message).toContain("code 1");
    expect(result.reason).toBe("process-error");
  });

  it("returns timeout error when process exits with rejection", async () => {
    const sid = uniqueSession();
    mockSpawn({ rejectExited: true });
    const result = await runClaude("slow message", sid, undefined, TEST_WORKSPACE, undefined, 60_000);
    expect(result.action).toBe("send");
    expect(result.message).toContain("[Error]");
    expect(result.message).toContain("timed out after 60s");
    expect(result.reason).toBe("timeout");
  });

  it("returns silent response when agent chooses silent", async () => {
    const sid = uniqueSession();
    mockSpawn({ stdout: jsonResponse("silent", "", "no new results"), exitCode: 0 });
    const result = await runClaude("check cron", sid, undefined, TEST_WORKSPACE);
    expect(result).toEqual({ action: "silent", message: "", reason: "no new results" });
  });

  it("falls back to result field when structured_output is missing", async () => {
    const sid = uniqueSession();
    const envelope = JSON.stringify({ type: "result", result: "plain text", duration_ms: 100, total_cost_usd: 0.01 });
    mockSpawn({ stdout: envelope, exitCode: 0 });
    const result = await runClaude("msg", sid, undefined, TEST_WORKSPACE);
    expect(result).toEqual({ action: "send", message: "plain text", reason: "no-structured-output" });
  });

  it("returns JSON error fallback when stdout is not valid JSON", async () => {
    const sid = uniqueSession();
    mockSpawn({ stdout: "not json at all", exitCode: 0 });
    const result = await runClaude("msg", sid, undefined, TEST_WORKSPACE);
    expect(result.action).toBe("send");
    expect(result.message).toContain("[JSON Error]");
    expect(result.message).toContain("not json at all");
    expect(result.reason).toBe("json-parse-failed");
  });

  it("newSessionId returns a valid UUID", () => {
    const id = newSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(newSessionId()).not.toBe(id);
  });

  it("calls proc.kill() when timeout fires", async () => {
    const sid = uniqueSession();
    let rejectExited!: (err: Error) => void;
    const proc = {
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: new Promise<number>((_, reject) => {
        rejectExited = reject;
      }),
      kill: mock(() => {
        rejectExited(new Error("killed"));
      }),
    };

    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => {
      fn();
      return 0 as any;
    }) as any;

    Bun.spawn = mock((() => proc) as any);
    const result = await runClaude("timeout test", sid, undefined, TEST_WORKSPACE, undefined, 60_000);
    globalThis.setTimeout = origSetTimeout;

    expect(proc.kill).toHaveBeenCalled();
    expect(result.action).toBe("send");
    expect(result.message).toContain("[Error]");
    expect(result.message).toContain("timed out after 60s");
    expect(result.reason).toBe("timeout");
  });

  it("does not set timeout when timeoutMs is not provided", async () => {
    const sid = uniqueSession();
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    const result = await runClaude("msg", sid, undefined, TEST_WORKSPACE);
    expect(result).toEqual({ action: "send", message: "ok", reason: "ok" });
  });
});
