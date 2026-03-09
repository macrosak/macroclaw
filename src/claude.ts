import { createLogger } from "./logger";

const log = createLogger("claude");

export interface ClaudeOptions {
  prompt: string;
  sessionFlag: "--resume" | "--session-id";
  sessionId: string;
  model?: string;
  workspace: string;
  systemPrompt?: string;
  jsonSchema: string;
  timeoutMs?: number;
}

export interface ClaudeResult {
  structuredOutput: unknown;
  result?: string;
  duration?: string;
  cost?: string;
}

export class ClaudeTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`Claude process timed out after ${Math.round(timeoutMs / 1000)}s`);
  }
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

export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  // Strip CLAUDECODE env var so nested claude sessions are allowed
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const args = ["claude", "-p", options.sessionFlag, options.sessionId, "--output-format", "json", "--json-schema", options.jsonSchema];
  if (options.model) args.push("--model", options.model);
  if (options.systemPrompt) args.push("--append-system-prompt", options.systemPrompt);
  args.push(options.prompt);

  log.debug(
    {
      model: options.model,
      sessionFlag: options.sessionFlag,
      sessionId: options.sessionId,
      promptLen: options.prompt.length,
      hasSystemPrompt: !!options.systemPrompt,
    },
    "Sending to Claude",
  );

  const proc = Bun.spawn(args, {
    cwd: options.workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, options.timeoutMs)
    : undefined;

  const exitCode = await proc.exited;
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    log.warn({ timeoutMs: options.timeoutMs }, "Claude process timed out");
    throw new ClaudeTimeoutError(options.timeoutMs as number);
  }

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    log.error({ exitCode, stderr: stderr.slice(0, 200) }, "Claude process failed");
    throw new ClaudeProcessError(exitCode, stderr);
  }

  const stdout = await new Response(proc.stdout).text();
  try {
    const envelope = JSON.parse(stdout);
    const duration = envelope.duration_ms ? `${(envelope.duration_ms / 1000).toFixed(1)}s` : undefined;
    const cost = envelope.total_cost_usd ? `$${envelope.total_cost_usd.toFixed(4)}` : undefined;
    const structuredOutput = envelope.structured_output ?? null;
    if (!structuredOutput) {
      log.debug({ envelope }, "No structured_output in envelope");
    }
    const result = typeof envelope.result === "string" ? envelope.result : undefined;
    log.debug({ duration, cost }, "Claude response received");
    return { structuredOutput, result, duration, cost };
  } catch {
    log.warn({ stdout: stdout.slice(0, 200) }, "Failed to parse Claude stdout as JSON");
    throw new ClaudeParseError(stdout);
  }
}
