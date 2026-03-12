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
    const args = ["claude", "-p", sessionFlag, options.sessionId, "--output-format", "json"];
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
