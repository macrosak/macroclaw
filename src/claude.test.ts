import { afterEach, describe, expect, it, mock } from "bun:test";
import { ClaudeParseError, ClaudeProcessError, ClaudeTimeoutError, runClaude } from "./claude";

function jsonResult(structuredOutput: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    total_cost_usd: 0.05,
    result: "",
    structured_output: structuredOutput,
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
}) {
  const proc = {
    stdout: new Response(opts.stdout ?? "").body,
    stderr: new Response(opts.stderr ?? "").body,
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill: mock(() => {}),
  };

  Bun.spawn = mock((() => proc) as any);
  return proc;
}

const TEST_WORKSPACE = "/tmp/macroclaw-test-workspace";
const DUMMY_SCHEMA = '{"type":"object"}';

function opts(overrides?: Record<string, unknown>) {
  return {
    prompt: "test message",
    sessionFlag: "--session-id" as const,
    sessionId: "sid-1",
    model: undefined,
    workspace: TEST_WORKSPACE,
    jsonSchema: DUMMY_SCHEMA,
    ...overrides,
  };
}

describe("runClaude", () => {
  it("passes --session-id flag when given", async () => {
    mockSpawn({ stdout: jsonResult({ action: "send", message: "Hello" }), exitCode: 0 });
    const result = await runClaude(opts());
    expect(result.structuredOutput).toEqual({ action: "send", message: "Hello" });
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "-p", "--session-id", "sid-1", "--output-format", "json", "--json-schema"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE, stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("passes --resume flag when given", async () => {
    mockSpawn({ stdout: jsonResult({ action: "send" }), exitCode: 0 });
    await runClaude(opts({ sessionFlag: "--resume", sessionId: "sid-2" }));
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "-p", "--resume", "sid-2"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE }),
    );
  });

  it("passes model flag when provided", async () => {
    mockSpawn({ stdout: jsonResult({ action: "send" }), exitCode: 0 });
    await runClaude(opts({ sessionId: "sid-3", model: "haiku", prompt: "msg" }));
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["--model", "haiku", "msg"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE }),
    );
  });

  it("passes --append-system-prompt when provided", async () => {
    mockSpawn({ stdout: jsonResult({ action: "send" }), exitCode: 0 });
    await runClaude(opts({ sessionId: "sid-4", systemPrompt: "You are a background agent.", prompt: "msg" }));
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["--append-system-prompt", "You are a background agent.", "msg"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE }),
    );
  });

  it("omits --append-system-prompt when undefined", async () => {
    mockSpawn({ stdout: jsonResult({ action: "send" }), exitCode: 0 });
    await runClaude(opts({ sessionId: "sid-5" }));
    const args = (Bun.spawn as any).mock.calls[0][0] as string[];
    expect(args).not.toContain("--append-system-prompt");
  });

  it("throws ClaudeProcessError on non-zero exit", async () => {
    mockSpawn({ stderr: "something went wrong", exitCode: 1 });
    try {
      await runClaude(opts({ sessionId: "sid-6" }));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeProcessError);
      expect((err as ClaudeProcessError).exitCode).toBe(1);
      expect((err as ClaudeProcessError).stderr).toBe("something went wrong");
    }
  });

  it("throws ClaudeTimeoutError when process is killed by timeout", async () => {
    let resolveExited!: (code: number) => void;
    const proc = {
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: new Promise<number>((resolve) => {
        resolveExited = resolve;
      }),
      kill: mock(() => {
        resolveExited(137);
      }),
    };

    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => {
      fn();
      return 0 as any;
    }) as any;

    Bun.spawn = mock((() => proc) as any);
    try {
      await runClaude(opts({ sessionId: "sid-7", timeoutMs: 60_000 }));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeTimeoutError);
      expect((err as ClaudeTimeoutError).timeoutMs).toBe(60_000);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }

    expect(proc.kill).toHaveBeenCalled();
  });

  it("returns structured_output from successful response", async () => {
    mockSpawn({ stdout: jsonResult({ action: "silent", actionReason: "no new results" }), exitCode: 0 });
    const result = await runClaude(opts({ sessionFlag: "--resume", sessionId: "sid-8" }));
    expect(result.structuredOutput).toEqual({ action: "silent", actionReason: "no new results" });
  });

  it("returns null structuredOutput when field is missing", async () => {
    const envelope = JSON.stringify({ type: "result", result: "plain text", duration_ms: 100, total_cost_usd: 0.01 });
    mockSpawn({ stdout: envelope, exitCode: 0 });
    const result = await runClaude(opts({ sessionFlag: "--resume", sessionId: "sid-9" }));
    expect(result.structuredOutput).toBeNull();
  });

  it("throws ClaudeParseError when stdout is not valid JSON", async () => {
    mockSpawn({ stdout: "not json at all", exitCode: 0 });
    try {
      await runClaude(opts({ sessionFlag: "--resume", sessionId: "sid-10" }));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeParseError);
      expect((err as ClaudeParseError).raw).toBe("not json at all");
    }
  });

  it("returns duration and cost from envelope", async () => {
    mockSpawn({ stdout: jsonResult({ action: "send" }), exitCode: 0 });
    const result = await runClaude(opts({ sessionFlag: "--resume", sessionId: "sid-11" }));
    expect(result.duration).toBe("1.2s");
    expect(result.cost).toBe("$0.0500");
  });

  it("does not set timeout when timeoutMs is not provided", async () => {
    mockSpawn({ stdout: jsonResult({ action: "send" }), exitCode: 0 });
    const result = await runClaude(opts({ sessionFlag: "--resume", sessionId: "sid-12" }));
    expect(result.structuredOutput).toEqual({ action: "send" });
  });

  it("passes jsonSchema to CLI args", async () => {
    const schema = '{"type":"object","properties":{}}';
    mockSpawn({ stdout: jsonResult({ action: "send" }), exitCode: 0 });
    await runClaude(opts({ sessionId: "sid-13", jsonSchema: schema }));
    const args = (Bun.spawn as any).mock.calls[0][0] as string[];
    expect(args).toContain(schema);
  });
});
