import { describe, it, expect, mock, afterEach } from "bun:test";
import { runClaude, newSessionId } from "./claude";

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

// Use unique session IDs per test to avoid knownSessions leaking between tests
let testCounter = 0;
function uniqueSession() {
  return `test-session-${++testCounter}`;
}

describe("runClaude", () => {
  it("uses --session-id on first call", async () => {
    const sid = uniqueSession();
    mockSpawn({ stdout: "Hello", exitCode: 0 });
    const result = await runClaude("test message", sid);
    expect(result).toBe("Hello");
    expect(Bun.spawn).toHaveBeenCalledWith(
      ["claude", "-p", "--session-id", sid, "test message"],
      expect.objectContaining({ stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("uses --resume on subsequent calls", async () => {
    const sid = uniqueSession();
    // First call to mark session as known
    mockSpawn({ stdout: "first", exitCode: 0 });
    await runClaude("msg1", sid);

    // Second call should use --resume
    mockSpawn({ stdout: "second", exitCode: 0 });
    await runClaude("msg2", sid);
    expect(Bun.spawn).toHaveBeenCalledWith(
      ["claude", "-p", "--resume", sid, "msg2"],
      expect.objectContaining({ stdout: "pipe", stderr: "pipe" }),
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
        stdout: new Response("retried ok").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    }) as any);

    const result = await runClaude("msg", sid);
    expect(result).toBe("retried ok");
    expect(callCount).toBe(2);
  });

  it("passes model flag when provided", async () => {
    const sid = uniqueSession();
    mockSpawn({ stdout: "ok", exitCode: 0 });
    await runClaude("msg", sid, "haiku");
    expect(Bun.spawn).toHaveBeenCalledWith(
      ["claude", "-p", "--session-id", sid, "--model", "haiku", "msg"],
      expect.objectContaining({ stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("returns error message on non-zero exit", async () => {
    const sid = uniqueSession();
    mockSpawn({ stderr: "something went wrong", exitCode: 1 });
    const result = await runClaude("bad message", sid);
    expect(result).toContain("[Error]");
    expect(result).toContain("something went wrong");
    expect(result).toContain("code 1");
  });

  it("returns timeout error when process exits with rejection", async () => {
    const sid = uniqueSession();
    mockSpawn({ rejectExited: true });
    const result = await runClaude("slow message", sid);
    expect(result).toContain("[Error]");
    expect(result).toContain("timed out");
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
    const result = await runClaude("timeout test", sid);
    globalThis.setTimeout = origSetTimeout;

    expect(proc.kill).toHaveBeenCalled();
    expect(result).toContain("[Error]");
    expect(result).toContain("timed out");
  });
});
