import { afterEach, describe, expect, it, mock } from "bun:test";
import { runClaude } from "./claude";

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

describe("runClaude", () => {
  it("passes --session-id flag when given", async () => {
    mockSpawn({ stdout: jsonResponse("send", "Hello", "user message"), exitCode: 0 });
    const result = await runClaude("test message", "--session-id", "sid-1", undefined, TEST_WORKSPACE);
    expect(result).toEqual({ action: "send", message: "Hello", reason: "user message" });
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "-p", "--session-id", "sid-1", "--output-format", "json", "--json-schema"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE, stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("passes --resume flag when given", async () => {
    mockSpawn({ stdout: jsonResponse("send", "Hello", "ok"), exitCode: 0 });
    await runClaude("msg", "--resume", "sid-2", undefined, TEST_WORKSPACE);
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "-p", "--resume", "sid-2", "--output-format", "json", "--json-schema"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE, stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("passes model flag when provided", async () => {
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    await runClaude("msg", "--session-id", "sid-3", "haiku", TEST_WORKSPACE);
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["claude", "-p", "--session-id", "sid-3", "--output-format", "json", "--json-schema", "--model", "haiku", "msg"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE, stdout: "pipe", stderr: "pipe" }),
    );
  });

  it("passes --append-system-prompt when systemPrompt is provided", async () => {
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    await runClaude("msg", "--session-id", "sid-4", undefined, TEST_WORKSPACE, "You are a background agent.");
    expect(Bun.spawn).toHaveBeenCalledWith(
      expect.arrayContaining(["--append-system-prompt", "You are a background agent.", "msg"]),
      expect.objectContaining({ cwd: TEST_WORKSPACE }),
    );
  });

  it("omits --append-system-prompt when systemPrompt is undefined", async () => {
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    await runClaude("msg", "--session-id", "sid-5", undefined, TEST_WORKSPACE);
    const args = (Bun.spawn as any).mock.calls[0][0] as string[];
    expect(args).not.toContain("--append-system-prompt");
  });

  it("returns error response on non-zero exit", async () => {
    mockSpawn({ stderr: "something went wrong", exitCode: 1 });
    const result = await runClaude("bad message", "--session-id", "sid-6", undefined, TEST_WORKSPACE);
    expect(result.action).toBe("send");
    expect(result.message).toContain("[Error]");
    expect(result.message).toContain("something went wrong");
    expect(result.message).toContain("code 1");
    expect(result.reason).toBe("process-error");
  });

  it("returns timeout error when process is killed by timeout", async () => {
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
    const result = await runClaude("slow message", "--session-id", "sid-7", undefined, TEST_WORKSPACE, undefined, 60_000);
    globalThis.setTimeout = origSetTimeout;

    expect(proc.kill).toHaveBeenCalled();
    expect(result.action).toBe("send");
    expect(result.message).toContain("[Error]");
    expect(result.message).toContain("timed out after 60s");
    expect(result.reason).toBe("timeout");
  });

  it("returns silent response when agent chooses silent", async () => {
    mockSpawn({ stdout: jsonResponse("silent", "", "no new results"), exitCode: 0 });
    const result = await runClaude("check cron", "--resume", "sid-8", undefined, TEST_WORKSPACE);
    expect(result).toEqual({ action: "silent", message: "", reason: "no new results" });
  });

  it("falls back to result field when structured_output is missing", async () => {
    const envelope = JSON.stringify({ type: "result", result: "plain text", duration_ms: 100, total_cost_usd: 0.01 });
    mockSpawn({ stdout: envelope, exitCode: 0 });
    const result = await runClaude("msg", "--resume", "sid-9", undefined, TEST_WORKSPACE);
    expect(result).toEqual({ action: "send", message: "plain text", reason: "no-structured-output" });
  });

  it("returns JSON error fallback when stdout is not valid JSON", async () => {
    mockSpawn({ stdout: "not json at all", exitCode: 0 });
    const result = await runClaude("msg", "--resume", "sid-10", undefined, TEST_WORKSPACE);
    expect(result.action).toBe("send");
    expect(result.message).toContain("[JSON Error]");
    expect(result.message).toContain("not json at all");
    expect(result.reason).toBe("json-parse-failed");
  });

  it("does not set timeout when timeoutMs is not provided", async () => {
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    const result = await runClaude("msg", "--resume", "sid-11", undefined, TEST_WORKSPACE);
    expect(result).toEqual({ action: "send", message: "ok", reason: "ok" });
  });

  it("prepends file references to prompt", async () => {
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    await runClaude("describe this", "--session-id", "sid-12", undefined, TEST_WORKSPACE, undefined, undefined, ["/tmp/photo.jpg", "/tmp/doc.pdf"]);
    const args = (Bun.spawn as any).mock.calls[0][0] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toBe("[File: /tmp/photo.jpg]\n[File: /tmp/doc.pdf]\ndescribe this");
  });

  it("sends only file references when message is empty", async () => {
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    await runClaude("", "--session-id", "sid-13", undefined, TEST_WORKSPACE, undefined, undefined, ["/tmp/photo.jpg"]);
    const args = (Bun.spawn as any).mock.calls[0][0] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toBe("[File: /tmp/photo.jpg]");
  });

  it("does not modify prompt when files is empty", async () => {
    mockSpawn({ stdout: jsonResponse("send", "ok", "ok"), exitCode: 0 });
    await runClaude("hello", "--session-id", "sid-14", undefined, TEST_WORKSPACE, undefined, undefined, []);
    const args = (Bun.spawn as any).mock.calls[0][0] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toBe("hello");
  });

  it("returns validation-failed when structured_output has wrong shape", async () => {
    const stdout = JSON.stringify({
      type: "result",
      duration_ms: 1000,
      total_cost_usd: 0.05,
      structured_output: { action: "invalid-action", message: "hi", reason: "ok" },
    });
    mockSpawn({ stdout, exitCode: 0 });
    const result = await runClaude("msg", "--resume", "sid-16", undefined, TEST_WORKSPACE);
    expect(result.action).toBe("send");
    expect(result.message).toBe("hi");
    expect(result.reason).toBe("validation-failed");
  });

  it("parses files array from structured output", async () => {
    const stdout = JSON.stringify({
      type: "result",
      duration_ms: 1000,
      total_cost_usd: 0.05,
      structured_output: { action: "send", message: "Here's the chart", reason: "ok", files: ["/tmp/chart.png"] },
    });
    mockSpawn({ stdout, exitCode: 0 });
    const result = await runClaude("msg", "--resume", "sid-15", undefined, TEST_WORKSPACE);
    expect(result.files).toEqual(["/tmp/chart.png"]);
  });
});
