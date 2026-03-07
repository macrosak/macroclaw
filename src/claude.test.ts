import { describe, it, expect, mock, afterEach } from "bun:test";
import { runClaude } from "./claude";

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

describe("runClaude", () => {
  it("returns stdout on successful execution", async () => {
    mockSpawn({ stdout: "Hello from Claude", exitCode: 0 });
    const result = await runClaude("test message", "test-session");
    expect(result).toBe("Hello from Claude");
    expect(Bun.spawn).toHaveBeenCalledWith(
      ["claude", "-p", "--session", "test-session", "test message"],
      expect.objectContaining({ stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("returns error message on non-zero exit", async () => {
    mockSpawn({ stderr: "something went wrong", exitCode: 1 });
    const result = await runClaude("bad message", "sess");
    expect(result).toContain("[Error]");
    expect(result).toContain("something went wrong");
    expect(result).toContain("code 1");
  });

  it("returns timeout error when process exits with rejection", async () => {
    mockSpawn({ rejectExited: true });
    const result = await runClaude("slow message", "sess");
    expect(result).toContain("[Error]");
    expect(result).toContain("timed out");
  });

  it("calls proc.kill() when timeout fires", async () => {
    // Create a proc whose `exited` is controlled by us
    let rejectExited!: (err: Error) => void;
    const proc = {
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: new Promise<number>((_, reject) => {
        rejectExited = reject;
      }),
      kill: mock(() => {
        // When kill is called, reject the exited promise
        rejectExited(new Error("killed"));
      }),
    };

    // Override setTimeout to fire immediately
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => {
      fn();
      return 0 as any;
    }) as any;

    Bun.spawn = mock((() => proc) as any);

    const result = await runClaude("timeout test", "sess");

    globalThis.setTimeout = origSetTimeout;

    expect(proc.kill).toHaveBeenCalled();
    expect(result).toContain("[Error]");
    expect(result).toContain("timed out");
  });
});
