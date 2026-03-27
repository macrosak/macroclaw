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
  systemPrompt?: string;
  /** Extra environment variables to set when spawning the Claude process */
  envVars?: Record<string, string>;
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

// --- ClaudeProcess ---

export type ProcessState = "idle" | "busy" | "dead";

/** Minimal interface for the underlying process — matches Bun.spawn output when stdin/stdout/stderr are "pipe" */
export interface RawProcess {
  stdin: { write(data: string): void; flush(): void; end(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

type StreamReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> };

export class ClaudeProcess<T = unknown> {
  readonly sessionId: string;
  readonly startedAt: Date;
  #state: ProcessState = "idle";
  #proc: RawProcess;
  #resultType: ResultType;
  #reader: StreamReader;
  #lines: AsyncGenerator<string>;

  constructor(proc: RawProcess, sessionId: string, resultType: ResultType) {
    this.#proc = proc;
    this.sessionId = sessionId;
    this.#resultType = resultType;
    this.startedAt = new Date();
    this.#reader = proc.stdout.getReader();
    this.#lines = ClaudeProcess.#readLines(this.#reader);

    proc.exited.then((code) => {
      if (this.#state !== "dead") {
        log.warn({ sessionId, exitCode: code }, "Process exited unexpectedly");
        this.#state = "dead";
        this.#reader.cancel().catch(() => {});
      }
    });
  }

  get state(): ProcessState {
    return this.#state;
  }

  async send(prompt: string): Promise<QueryResult<T>> {
    if (this.#state !== "idle") {
      throw new Error(`Cannot send: process is ${this.#state}`);
    }
    this.#state = "busy";

    const msg = `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`;

    try {
      this.#proc.stdin.write(msg);
      this.#proc.stdin.flush();
    } catch (err) {
      this.#state = "dead";
      throw new QueryProcessError(-1, `Failed to write to stdin: ${err}`);
    }

    log.debug({ sessionId: this.sessionId, promptLen: prompt.length }, "Sent to Claude");

    while (true) {
      const { done, value: line } = await this.#lines.next();
      if (done) {
        this.#state = "dead";
        const exitCode = await this.#proc.exited;
        const stderr = await new Response(this.#proc.stderr).text();
        log.error({ exitCode, stderr: stderr.slice(0, 200) }, "Claude process ended unexpectedly");
        throw new QueryProcessError(exitCode, stderr);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        log.debug({ line: line.slice(0, 100) }, "Skipping non-JSON line");
        continue;
      }

      if (parsed.type !== "result") {
        const thinking = ClaudeProcess.#extractThinking(parsed);
        if (thinking) log.debug({ thinking }, "Thinking");
        continue;
      }

      this.#state = "idle";
      return this.#parseResult(parsed);
    }
  }

  async kill(): Promise<void> {
    if (this.#state === "dead") return;
    this.#state = "dead";
    this.#reader.cancel().catch(() => {});
    this.#proc.kill();
    await this.#proc.exited;
  }

  #parseResult(envelope: Record<string, unknown>): QueryResult<T> {
    const sid = typeof envelope.session_id === "string" ? envelope.session_id : this.sessionId;
    const durationMs = typeof envelope.duration_ms === "number" ? envelope.duration_ms : undefined;
    const costUsd = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined;
    const duration = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : undefined;
    const cost = costUsd ? `$${costUsd.toFixed(4)}` : undefined;

    let value: T;
    if (this.#resultType.type === "text") {
      value = (typeof envelope.result === "string" ? envelope.result : "") as T;
    } else {
      const raw = envelope.structured_output;
      try {
        value = (this.#resultType as { type: "object"; schema: z.ZodType }).schema.parse(raw) as T;
      } catch (err) {
        throw new QueryValidationError(raw, err);
      }
    }

    log.debug({ duration, cost, sessionId: sid }, "Claude response received");
    return { value, sessionId: sid, duration, cost };
  }

  static #extractThinking(event: Record<string, unknown>): string | undefined {
    if (event.type !== "assistant") return undefined;
    const msg = event.message as Record<string, unknown> | undefined;
    const content = msg?.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return undefined;
    const block = content.find((c) => c.type === "thinking");
    return typeof block?.thinking === "string" ? block.thinking : undefined;
  }

  static async *#readLines(reader: StreamReader): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield line;
      }
    }
    if (buffer.trim()) yield buffer;
  }
}

// --- Claude factory ---

type SessionMode =
  | { kind: "new" }
  | { kind: "resume"; sessionId: string }
  | { kind: "fork"; sessionId: string };

export class Claude {
  readonly #workspace: string;
  readonly #model?: string;
  readonly #systemPrompt?: string;
  readonly #envVars: Record<string, string>;

  constructor(config: ClaudeConfig) {
    this.#workspace = config.workspace;
    this.#model = config.model;
    this.#systemPrompt = config.systemPrompt;
    this.#envVars = config.envVars ?? {};
  }

  newSession<R extends ResultType>(resultType: R, options?: QueryOptions): ClaudeProcess<InferResult<R>> {
    return this.#spawn({ kind: "new" }, resultType, options);
  }

  resumeSession<R extends ResultType>(sessionId: string, resultType: R, options?: QueryOptions): ClaudeProcess<InferResult<R>> {
    return this.#spawn({ kind: "resume", sessionId }, resultType, options);
  }

  forkSession<R extends ResultType>(sessionId: string, resultType: R, options?: QueryOptions): ClaudeProcess<InferResult<R>> {
    return this.#spawn({ kind: "fork", sessionId }, resultType, options);
  }

  #spawn<R extends ResultType>(mode: SessionMode, resultType: R, options?: QueryOptions): ClaudeProcess<InferResult<R>> {
    const env = { ...process.env, ...this.#envVars };
    delete env.CLAUDECODE;

    const model = options?.model ?? this.#model;
    const systemPrompt = options?.systemPrompt ?? this.#systemPrompt;
    const sessionId = mode.kind === "resume" ? mode.sessionId : crypto.randomUUID();

    const args = [
      "claude", "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--disallowedTools", "CronList,CronDelete,CronCreate,AskUserQuestion,RemoteTrigger",
    ];

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
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

    log.debug({ model, sessionId, mode: mode.kind, hasSystemPrompt: !!systemPrompt }, "Spawning Claude process");

    const proc = Bun.spawn(args, { cwd: this.#workspace, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

    return new ClaudeProcess<InferResult<R>>(proc, sessionId, resultType);
  }
}
