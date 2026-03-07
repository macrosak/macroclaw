import { randomUUID } from "crypto";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const knownSessions = new Set<string>();

export interface ClaudeResponse {
  action: "send" | "silent" | "background";
  message: string;
  reason: string;
  name?: string;
}

const jsonSchema = JSON.stringify({
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["send", "silent", "background"],
    },
    message: {
      type: "string",
      description: "The message to send to Telegram, or the prompt for background agents",
    },
    name: {
      type: "string",
      description: "Label for background agent (only used when action is background)",
    },
    reason: {
      type: "string",
      description: "Why the agent chose this action (logged, not sent)",
    },
  },
  required: ["action", "message", "reason"],
});

export async function runClaude(
  message: string,
  sessionId: string,
  model: string | undefined,
  workspace: string,
  systemPrompt?: string,
): Promise<ClaudeResponse> {
  // Strip CLAUDECODE env var so nested claude sessions are allowed
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // First call for a session uses --session-id, subsequent calls use --resume
  const sessionFlag = knownSessions.has(sessionId)
    ? "--resume"
    : "--session-id";
  const args = ["claude", "-p", sessionFlag, sessionId, "--output-format", "json", "--json-schema", jsonSchema];
  if (model) args.push("--model", model);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  args.push(message);

  // Log the full command so it can be copy-pasted
  const shellCmd = args.map(a => a.includes(" ") ? `'${a}'` : a).join(" ");
  console.log(`[claude] $ ${shellCmd}`);

  const proc = Bun.spawn(args, {
    cwd: workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    proc.kill();
  }, TIMEOUT_MS);

  try {
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode === 0) {
      knownSessions.add(sessionId);
      const stdout = await new Response(proc.stdout).text();
      console.log(`[claude] Response (${stdout.length} chars):\n${stdout}`);
      try {
        const envelope = JSON.parse(stdout);
        const duration = envelope.duration_ms ? `${(envelope.duration_ms / 1000).toFixed(1)}s` : "?";
        const cost = envelope.total_cost_usd ? `$${envelope.total_cost_usd.toFixed(4)}` : "?";
        console.log(`[claude] duration=${duration} cost=${cost}`);
        if (envelope.structured_output) {
          return envelope.structured_output as ClaudeResponse;
        }
        return { action: "send", message: envelope.result ?? stdout, reason: "no-structured-output" };
      } catch {
        return { action: "send", message: `[JSON Error] ${stdout}`, reason: "json-parse-failed" };
      }
    }

    const stderr = await new Response(proc.stderr).text();
    console.log(`[claude] Error (exit ${exitCode}):\n${stderr}`);

    // If --session-id fails because session exists, retry with --resume
    if (sessionFlag === "--session-id" && stderr.includes("already in use")) {
      knownSessions.add(sessionId);
      return runClaude(message, sessionId, model, workspace, systemPrompt);
    }

    return { action: "send", message: `[Error] Claude exited with code ${exitCode}:\n${stderr}`, reason: "process-error" };
  } catch {
    clearTimeout(timeout);
    return { action: "send", message: "[Error] Claude process timed out after 5 minutes.", reason: "process-error" };
  }
}

export function newSessionId(): string {
  return randomUUID();
}
