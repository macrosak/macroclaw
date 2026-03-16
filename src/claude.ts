import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("claude");

/** Describes the expected output format */
export type ResultType<T = unknown> = { type: "text" } | { type: "object"; schema: z.ZodType<T> };

/** Infer the output type from a ResultType */
export type InferResult<R extends ResultType> = R extends { type: "text" }
  ? string
  : R extends { type: "object"; schema: z.ZodType<infer T> }
    ? T
    : unknown;

/** Constructor config — defaults for all sessions */
export interface ClaudeConfig {
  workspace: string;
  model?: string;
  appendSystemPrompt?: string;
}

/** Per-call overrides */
export interface QueryOptions {
  model?: string;
  appendSystemPrompt?: string;
  replaceSystemPrompt?: string;
}

/** Resolved query result — wraps the typed output with metadata */
export interface QueryResult<T> {
  value: T;
  sessionId: string;
  duration?: string;
  cost?: string;
}

/** A running query — result is always deferred */
export interface RunningQuery<T> {
  sessionId: string;
  startedAt: Date;
  result: Promise<QueryResult<T>>;
  kill: () => Promise<void>;
}

/** Claude process exited with non-zero code */
export class QueryProcessError extends Error {
  constructor(
    public exitCode: number,
    public stderr: string,
  ) {
    super(`Claude exited with code ${exitCode}:\n${stderr}`);
  }
}

/** Claude returned output that couldn't be parsed as JSON */
export class QueryParseError extends Error {
  constructor(public raw: string) {
    super("Failed to parse Claude output as JSON");
  }
}

/** Claude returned output that didn't match the expected schema */
export class QueryValidationError extends Error {
  constructor(
    public raw: unknown,
    public cause: unknown,
  ) {
    super("Claude output did not match the expected schema");
  }
}

type SessionMode =
  | { kind: "new" }
  | { kind: "resume"; sessionId: string }
  | { kind: "fork"; sessionId: string };

export class Claude {
  #workspace: string;
  #model?: string;
  #appendSystemPrompt?: string;

  constructor(config: ClaudeConfig) {
    this.#workspace = config.workspace;
    this.#model = config.model;
    this.#appendSystemPrompt = config.appendSystemPrompt;
  }

  newSession<R extends ResultType>(prompt: string, resultType: R, options?: QueryOptions): RunningQuery<InferResult<R>> {
    return this.#spawn({ kind: "new" }, prompt, resultType, options);
  }

  resumeSession<R extends ResultType>(sessionId: string, prompt: string, resultType: R, options?: QueryOptions): RunningQuery<InferResult<R>> {
    return this.#spawn({ kind: "resume", sessionId }, prompt, resultType, options);
  }

  forkSession<R extends ResultType>(sessionId: string, prompt: string, resultType: R, options?: QueryOptions): RunningQuery<InferResult<R>> {
    return this.#spawn({ kind: "fork", sessionId }, prompt, resultType, options);
  }

  #spawn<R extends ResultType>(mode: SessionMode, prompt: string, resultType: R, options?: QueryOptions): RunningQuery<InferResult<R>> {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const model = options?.model ?? this.#model;
    const sessionId = mode.kind === "resume" ? mode.sessionId : crypto.randomUUID();

    const args = ["claude", "-p", "--output-format", "json", "--disallowedTools", "CronList,CronDelete,CronCreate,AskUserQuestion"];

    if (mode.kind === "resume") {
      args.push("--resume", sessionId);
    } else if (mode.kind === "fork") {
      args.push("--resume", mode.sessionId, "--fork-session", "--session-id", sessionId);
    } else {
      args.push("--session-id", sessionId);
    }

    if (resultType.type === "object") {
      args.push("--json-schema", JSON.stringify(z.toJSONSchema(resultType.schema, { target: "jsonSchema7" })));
    }

    if (model) args.push("--model", model);
    if (options?.replaceSystemPrompt) {
      args.push("--system-prompt", options.replaceSystemPrompt);
    } else {
      const appendPrompt = options?.appendSystemPrompt ?? this.#appendSystemPrompt;
      if (appendPrompt) args.push("--append-system-prompt", appendPrompt);
    }
    args.push(prompt);

    log.debug({ cmd: args.join(" "), sessionId, mode: mode.kind }, "Sending to Claude");

    const proc = Bun.spawn(args, { cwd: this.#workspace, env, stdout: "pipe", stderr: "pipe" });
    const startedAt = new Date();

    const result = (async (): Promise<QueryResult<InferResult<R>>> => {
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        log.error({ exitCode, stderr: stderr.slice(0, 200) }, "Claude process failed");
        throw new QueryProcessError(exitCode, stderr);
      }

      const stdout = await new Response(proc.stdout).text();
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        log.warn({ stdout: stdout.slice(0, 200) }, "Failed to parse Claude stdout as JSON");
        throw new QueryParseError(stdout);
      }

      const sid = typeof envelope.session_id === "string" ? envelope.session_id : sessionId;
      const durationMs = typeof envelope.duration_ms === "number" ? envelope.duration_ms : undefined;
      const costUsd = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined;
      const duration = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : undefined;
      const cost = costUsd ? `$${costUsd.toFixed(4)}` : undefined;

      let value: InferResult<R>;
      if (resultType.type === "text") {
        value = (typeof envelope.result === "string" ? envelope.result : "") as InferResult<R>;
      } else {
        const raw = envelope.structured_output;
        try {
          value = resultType.schema.parse(raw) as InferResult<R>;
        } catch (err) {
          throw new QueryValidationError(raw, err);
        }
      }

      log.debug({ duration, cost, sessionId: sid }, "Claude response received");
      return { value, sessionId: sid, duration, cost };
    })();

    return {
      sessionId,
      startedAt,
      result,
      kill: async () => {
        proc.kill();
        await proc.exited;
      },
    };
  }
}
