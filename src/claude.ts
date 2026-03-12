import { createLogger } from "./logger";

const log = createLogger("claude");

export interface ClaudeRunOptions {
  prompt: string;
  resume?: boolean;
  sessionId: string;
  forkSession?: boolean;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  plainText?: boolean;
}

export interface ClaudeResult {
  structuredOutput: unknown;
  sessionId: string;
  result?: string;
  duration?: string;
  cost?: string;
}

export interface ClaudeDeferredResult {
  deferred: true;
  sessionId: string;
  completion: Promise<ClaudeResult>;
}

export function isDeferred<T>(result: T | ClaudeDeferredResult): result is ClaudeDeferredResult {
  return result != null && typeof result === "object" && "deferred" in result && (result as ClaudeDeferredResult).deferred === true;
}

export class ClaudeProcessError extends Error {
  constructor(
    public exitCode: number,
    public stderr: string,
  ) {
    super(`Claude exited with code ${exitCode}:\n${stderr}`);
  }
}

export class ClaudeParseError extends Error {
  constructor(public raw: string) {
    super(`Failed to parse Claude output as JSON`);
  }
}

function parseEnvelope(stdout: string): ClaudeResult {
  try {
    const envelope = JSON.parse(stdout);
    const duration = envelope.duration_ms ? `${(envelope.duration_ms / 1000).toFixed(1)}s` : undefined;
    const cost = envelope.total_cost_usd ? `$${envelope.total_cost_usd.toFixed(4)}` : undefined;
    const structuredOutput = envelope.structured_output ?? null;
    if (!structuredOutput) {
      log.debug({ envelope }, "No structured_output in envelope");
    }
    const sid = typeof envelope.session_id === "string" ? envelope.session_id : "";
    const result = typeof envelope.result === "string" ? envelope.result : undefined;
    log.debug({ duration, cost, sessionId: sid }, "Claude response received");
    return { structuredOutput, sessionId: sid, result, duration, cost };
  } catch {
    log.warn({ stdout: stdout.slice(0, 200) }, "Failed to parse Claude stdout as JSON");
    throw new ClaudeParseError(stdout);
  }
}

async function awaitProcess(proc: { exited: Promise<number>; stdout: ReadableStream<Uint8Array> | null; stderr: ReadableStream<Uint8Array> | null }): Promise<ClaudeResult> {
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    log.error({ exitCode, stderr: stderr.slice(0, 200) }, "Claude process failed");
    throw new ClaudeProcessError(exitCode, stderr);
  }
  const stdout = await new Response(proc.stdout).text();
  return parseEnvelope(stdout);
}

export class Claude {
  #workspace: string;
  #jsonSchema: string;

  constructor(config: { workspace: string; jsonSchema: string }) {
    this.#workspace = config.workspace;
    this.#jsonSchema = config.jsonSchema;
  }

  async run(options: ClaudeRunOptions): Promise<ClaudeResult | ClaudeDeferredResult> {
    // Strip CLAUDECODE env var so nested claude sessions are allowed
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const sessionFlag = options.resume ? "--resume" : "--session-id";
    const args = [
      "claude",
      "-p",
      sessionFlag,
      options.sessionId,
      "--output-format",
      "json",
      "--disallowedTools",
      "CronList,CronDelete,CronCreate,AskUserQuestion",
    ];
    if (!options.plainText) args.push("--json-schema", this.#jsonSchema);
    if (options.forkSession) args.push("--fork-session");
    if (options.model) args.push("--model", options.model);
    if (options.systemPrompt) args.push("--append-system-prompt", options.systemPrompt);
    args.push(options.prompt);

    log.debug(
      {
        model: options.model,
        resume: options.resume,
        sessionId: options.sessionId,
        promptLen: options.prompt.length,
        hasSystemPrompt: !!options.systemPrompt,
      },
      "Sending to Claude",
    );

    const proc = Bun.spawn(args, {
      cwd: this.#workspace,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const completion = awaitProcess(proc);

    if (!options.timeoutMs) {
      return completion;
    }

    const result = await Promise.race([
      completion.then((r) => ({ kind: "done" as const, value: r })),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), options.timeoutMs)),
    ]);

    if (result.kind === "done") return result.value;

    log.info({ timeoutMs: options.timeoutMs, sessionId: options.sessionId }, "Claude process timed out, deferring to background");
    return {
      deferred: true,
      sessionId: options.sessionId,
      completion,
    };
  }
}

// ---------- New API ----------

/** Generic schema interface — compatible with Zod, Arktype, or any parser */
export interface Schema<T> {
  parse(data: unknown): T;
}

/** Describes the expected output format */
export type ResultType<T = unknown> = { type: "text" } | { type: "object"; schema: Schema<T> };

/** Infer the output type from a ResultType */
export type InferResult<R extends ResultType> = R extends { type: "text" }
  ? string
  : R extends { type: "object"; schema: Schema<infer T> }
    ? T
    : unknown;

/** Constructor config — defaults for all sessions */
export interface ClaudeConfig {
  workspace: string;
  model?: string;
  systemPrompt?: string;
}

/** Per-call overrides */
export interface QueryOptions {
  model?: string;
  systemPrompt?: string;
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

export class Claude2 {
  #workspace: string;
  #model?: string;
  #systemPrompt?: string;

  constructor(config: ClaudeConfig) {
    this.#workspace = config.workspace;
    this.#model = config.model;
    this.#systemPrompt = config.systemPrompt;
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
    const systemPrompt = options?.systemPrompt ?? this.#systemPrompt;
    const sessionId = mode.kind === "new" ? crypto.randomUUID() : mode.sessionId;

    const args = ["claude", "-p", "--output-format", "json", "--disallowedTools", "CronList,CronDelete,CronCreate,AskUserQuestion"];

    if (mode.kind === "resume" || mode.kind === "fork") {
      args.push("--resume", sessionId);
    } else {
      args.push("--session-id", sessionId);
    }

    if (mode.kind === "fork") args.push("--fork-session");

    if (resultType.type === "object") {
      args.push("--json-schema", JSON.stringify(resultType.schema));
    }

    if (model) args.push("--model", model);
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    args.push(prompt);

    log.debug({ model, sessionId, promptLen: prompt.length, mode: mode.kind, hasSystemPrompt: !!systemPrompt }, "Sending to Claude");

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
