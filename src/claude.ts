import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("claude");

const claudeResponseSchema = z.object({
  action: z.enum(["send", "silent", "background"]),
  message: z.string().describe("The message to send to Telegram, or the prompt for background agents"),
  reason: z.string().describe("Why the agent chose this action (logged, not sent)"),
  name: z.string().describe("Label for background agent (only used when action is background)").optional(),
  files: z.array(z.string()).describe("Absolute paths to files to send to Telegram (optional)").optional(),
});

export type ClaudeResponse = z.infer<typeof claudeResponseSchema>;

const jsonSchema = JSON.stringify(z.toJSONSchema(claudeResponseSchema));

export async function runClaude(
  message: string,
  sessionFlag: "--resume" | "--session-id",
  sessionId: string,
  model: string | undefined,
  workspace: string,
  systemPrompt?: string,
  timeoutMs?: number,
  files?: string[],
): Promise<ClaudeResponse> {
  // Strip CLAUDECODE env var so nested claude sessions are allowed
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // Prepend file references to the prompt
  let prompt = message;
  if (files?.length) {
    const prefix = files.map((f) => `[File: ${f}]`).join("\n");
    prompt = prompt ? `${prefix}\n${prompt}` : prefix;
  }

  const args = ["claude", "-p", sessionFlag, sessionId, "--output-format", "json", "--json-schema", jsonSchema];
  if (model) args.push("--model", model);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  args.push(prompt);

  log.debug({ prompt: prompt.slice(0, 120) }, "Sending to Claude");

  const proc = Bun.spawn(args, {
    cwd: workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs)
    : undefined;

  const exitCode = await proc.exited;
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    const secs = Math.round((timeoutMs as number) / 1000);
    log.warn({ timeoutSecs: secs }, "Claude process timed out");
    return { action: "send", message: `[Error] Claude process timed out after ${secs}s.`, reason: "timeout" };
  }

  if (exitCode === 0) {
    const stdout = await new Response(proc.stdout).text();
    try {
      const envelope = JSON.parse(stdout);
      const duration = envelope.duration_ms ? `${(envelope.duration_ms / 1000).toFixed(1)}s` : "?";
      const cost = envelope.total_cost_usd ? `$${envelope.total_cost_usd.toFixed(4)}` : "?";
      log.debug({ duration, cost }, "Claude response received");
      if (envelope.structured_output) {
        const parsed = claudeResponseSchema.safeParse(envelope.structured_output);
        if (parsed.success) return parsed.data;
        log.warn({ error: parsed.error.message }, "structured_output failed validation");
        return { action: "send", message: envelope.structured_output.message ?? stdout, reason: "validation-failed" };
      }
      log.warn({ envelope }, "No structured_output in response");
      return { action: "send", message: envelope.result ?? stdout, reason: "no-structured-output" };
    } catch {
      log.warn({ stdout: stdout.slice(0, 200) }, "Failed to parse Claude stdout as JSON");
      return { action: "send", message: `[JSON Error] ${stdout}`, reason: "json-parse-failed" };
    }
  }

  const stderr = await new Response(proc.stderr).text();
  log.error({ exitCode, stderr: stderr.slice(0, 200) }, "Claude process failed");

  return { action: "send", message: `[Error] Claude exited with code ${exitCode}:\n${stderr}`, reason: "process-error" };
}
