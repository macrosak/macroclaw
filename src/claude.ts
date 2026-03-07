import { randomUUID } from "crypto";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const knownSessions = new Set<string>();

export interface ClaudeResponse {
  action: "send" | "silent";
  message: string;
  reason: string;
}

const jsonSchema = JSON.stringify({
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["send", "silent"],
    },
    message: {
      type: "string",
      description: "The message to send to Telegram",
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
): Promise<ClaudeResponse> {
  // Strip CLAUDECODE env var so nested claude sessions are allowed
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // First call for a session uses --session-id, subsequent calls use --resume
  const sessionFlag = knownSessions.has(sessionId)
    ? "--resume"
    : "--session-id";
  const args = ["claude", "-p", sessionFlag, sessionId, "--json-schema", jsonSchema];
  if (model) args.push("--model", model);
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
        return JSON.parse(stdout) as ClaudeResponse;
      } catch {
        return { action: "send", message: `[JSON Error] ${stdout}`, reason: "json-parse-failed" };
      }
    }

    const stderr = await new Response(proc.stderr).text();
    console.log(`[claude] Error (exit ${exitCode}):\n${stderr}`);

    // If --session-id fails because session exists, retry with --resume
    if (sessionFlag === "--session-id" && stderr.includes("already in use")) {
      knownSessions.add(sessionId);
      return runClaude(message, sessionId, model, workspace);
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
