import { afterEach, describe, expect, it, mock } from "bun:test";
import { z } from "zod/v4";
import { Claude, QueryParseError, QueryProcessError, QueryValidationError } from "./claude";

function envelope(opts: { structuredOutput?: unknown; result?: string; sessionId?: string; durationMs?: number; costUsd?: number }): string {
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

const originalSpawn = Bun.spawn;

afterEach(() => {
  Bun.spawn = originalSpawn;
});

function mockSpawn(opts: { stdout?: string; stderr?: string; exitCode?: number }) {
  const proc = {
    stdout: new Response(opts.stdout ?? "").body,
    stderr: new Response(opts.stderr ?? "").body,
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill: mock(() => {}),
  };
  Bun.spawn = mock((() => proc) as any);
  return proc;
}

function mockHangingSpawn(stdout: string) {
  let resolveExited!: (code: number) => void;
  const proc = {
    stdout: new Response(stdout).body,
    stderr: new Response("").body,
    exited: new Promise<number>((resolve) => {
      resolveExited = resolve;
    }),
    kill: mock(() => {}),
  };
  Bun.spawn = mock((() => proc) as any);
  return { proc, resolveExited };
}

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

describe("Claude", () => {
  describe("newSession", () => {
    it("uses --session-id with a generated UUID", async () => {
      mockSpawn({ stdout: envelope({ result: "hi" }), exitCode: 0 });
      const claude = makeClaude();
      const query = claude.newSession("hello", textResult);

      expect(query.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const args = spawnArgs();
      expect(args).toContain("--session-id");
      expect(args).toContain(query.sessionId);
      expect(args).not.toContain("--resume");
      expect(args).not.toContain("--fork-session");

      await query.result;
    });

    it("returns text value for text resultType", async () => {
      mockSpawn({ stdout: envelope({ result: "hello world" }), exitCode: 0 });
      const claude = makeClaude();
      const { value } = await claude.newSession("hi", textResult).result;
      expect(value).toBe("hello world");
    });

    it("returns parsed value for object resultType", async () => {
      mockSpawn({ stdout: envelope({ structuredOutput: { action: "send", message: "hi" } }), exitCode: 0 });
      const claude = makeClaude();
      const schema = objectResult();
      const { value } = await claude.newSession("hi", schema).result;
      expect(value).toEqual({ action: "send", message: "hi" });
    });
  });

  describe("resumeSession", () => {
    it("uses --resume with the provided sessionId", async () => {
      mockSpawn({ stdout: envelope({ result: "resumed" }), exitCode: 0 });
      const claude = makeClaude();
      const query = claude.resumeSession("existing-sid", "continue", textResult);

      expect(query.sessionId).toBe("existing-sid");
      const args = spawnArgs();
      expect(args).toContain("--resume");
      expect(args).toContain("existing-sid");
      expect(args).not.toContain("--session-id");
      expect(args).not.toContain("--fork-session");

      await query.result;
    });
  });

  describe("forkSession", () => {
    it("uses --resume and --fork-session with the provided sessionId", async () => {
      mockSpawn({ stdout: envelope({ result: "forked" }), exitCode: 0 });
      const claude = makeClaude();
      const query = claude.forkSession("parent-sid", "bg task", textResult);

      expect(query.sessionId).toBe("parent-sid");
      const args = spawnArgs();
      expect(args).toContain("--resume");
      expect(args).toContain("parent-sid");
      expect(args).toContain("--fork-session");

      await query.result;
    });
  });

  describe("options", () => {
    it("uses constructor model as default", async () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude({ model: "sonnet" });
      await claude.newSession("hi", textResult).result;
      expect(spawnArgs()).toContain("sonnet");
    });

    it("per-call model overrides constructor model", async () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude({ model: "sonnet" });
      await claude.newSession("hi", textResult, { model: "haiku" }).result;
      const args = spawnArgs();
      expect(args).toContain("haiku");
      expect(args).not.toContain("sonnet");
    });

    it("uses constructor systemPrompt as default", async () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude({ systemPrompt: "Be helpful." });
      await claude.newSession("hi", textResult).result;
      const args = spawnArgs();
      expect(args).toContain("--append-system-prompt");
      expect(args).toContain("Be helpful.");
    });

    it("per-call systemPrompt overrides constructor systemPrompt", async () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude({ systemPrompt: "Be helpful." });
      await claude.newSession("hi", textResult, { systemPrompt: "Be brief." }).result;
      const args = spawnArgs();
      expect(args).toContain("Be brief.");
      expect(args).not.toContain("Be helpful.");
    });

    it("omits --model when none specified", async () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude();
      await claude.newSession("hi", textResult).result;
      expect(spawnArgs()).not.toContain("--model");
    });

    it("omits --append-system-prompt when none specified", async () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude();
      await claude.newSession("hi", textResult).result;
      expect(spawnArgs()).not.toContain("--append-system-prompt");
    });
  });

  describe("resultType", () => {
    it("omits --json-schema for text resultType", async () => {
      mockSpawn({ stdout: envelope({ result: "plain" }), exitCode: 0 });
      const claude = makeClaude();
      await claude.newSession("hi", textResult).result;
      expect(spawnArgs()).not.toContain("--json-schema");
    });

    it("passes --json-schema for object resultType", async () => {
      mockSpawn({ stdout: envelope({ structuredOutput: { ok: true } }), exitCode: 0 });
      const claude = makeClaude();
      const schema = objectResult();
      await claude.newSession("hi", schema).result;
      const args = spawnArgs();
      expect(args).toContain("--json-schema");
    });

    it("validates structured output through schema.parse", async () => {
      mockSpawn({ stdout: envelope({ structuredOutput: { count: 5 } }), exitCode: 0 });
      const claude = makeClaude();
      const schema = objectResult(z.object({ count: z.number() }));
      const { value } = await claude.newSession("hi", schema).result;
      expect(value).toEqual({ count: 5 });
    });
  });

  describe("metadata", () => {
    it("returns duration and cost", async () => {
      mockSpawn({ stdout: envelope({ result: "ok", durationMs: 2500, costUsd: 0.123 }), exitCode: 0 });
      const claude = makeClaude();
      const { duration, cost } = await claude.newSession("hi", textResult).result;
      expect(duration).toBe("2.5s");
      expect(cost).toBe("$0.1230");
    });

    it("returns sessionId from server envelope", async () => {
      mockSpawn({ stdout: envelope({ result: "ok", sessionId: "server-returned-sid" }), exitCode: 0 });
      const claude = makeClaude();
      const { sessionId } = await claude.newSession("hi", textResult).result;
      expect(sessionId).toBe("server-returned-sid");
    });

    it("sets startedAt on the running query", () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude();
      const before = new Date();
      const query = claude.newSession("hi", textResult);
      const after = new Date();
      expect(query.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(query.startedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe("errors", () => {
    it("rejects with QueryProcessError on non-zero exit", async () => {
      mockSpawn({ stderr: "boom", exitCode: 1 });
      const claude = makeClaude();
      try {
        await claude.newSession("hi", textResult).result;
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(QueryProcessError);
        expect((err as QueryProcessError).exitCode).toBe(1);
        expect((err as QueryProcessError).stderr).toBe("boom");
      }
    });

    it("rejects with QueryParseError on invalid JSON", async () => {
      mockSpawn({ stdout: "not json", exitCode: 0 });
      const claude = makeClaude();
      try {
        await claude.newSession("hi", textResult).result;
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(QueryParseError);
        expect((err as QueryParseError).raw).toBe("not json");
      }
    });

    it("rejects with QueryValidationError when schema.parse throws", async () => {
      mockSpawn({ stdout: envelope({ structuredOutput: { bad: true } }), exitCode: 0 });
      const claude = makeClaude();
      const schema = objectResult(z.object({ count: z.number() }).strict());
      try {
        await claude.newSession("hi", schema).result;
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(QueryValidationError);
        expect((err as QueryValidationError).raw).toEqual({ bad: true });
      }
    });
  });

  describe("kill", () => {
    it("kills the process and waits for exit", async () => {
      const { proc, resolveExited } = mockHangingSpawn(envelope({ result: "done" }));
      const claude = makeClaude();
      const query = claude.newSession("hi", textResult);

      const killPromise = query.kill();
      resolveExited(0);
      await killPromise;
      expect(proc.kill).toHaveBeenCalled();
    });
  });

  describe("environment", () => {
    it("strips CLAUDECODE env var", async () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude();
      await claude.newSession("hi", textResult).result;
      const spawnOpts = (Bun.spawn as any).mock.calls[0][1];
      expect(spawnOpts.env).not.toHaveProperty("CLAUDECODE");
    });

    it("spawns in the configured workspace directory", async () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude();
      await claude.newSession("hi", textResult).result;
      const spawnOpts = (Bun.spawn as any).mock.calls[0][1];
      expect(spawnOpts.cwd).toBe(TEST_WORKSPACE);
    });

    it("includes disallowedTools in CLI args", async () => {
      mockSpawn({ stdout: envelope({ result: "ok" }), exitCode: 0 });
      const claude = makeClaude();
      await claude.newSession("hi", textResult).result;
      const args = spawnArgs();
      expect(args).toContain("--disallowedTools");
      expect(args).toContain("CronList,CronDelete,CronCreate,AskUserQuestion");
    });
  });
});
