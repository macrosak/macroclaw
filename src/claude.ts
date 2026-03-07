import { resolve, dirname } from "path";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const WORKSPACE = resolve(dirname(import.meta.dir), "..", "macroclaw-workspace");

export async function runClaude(
  message: string,
  sessionId: string,
): Promise<string> {
  // Strip CLAUDECODE env var so nested claude sessions are allowed
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = Bun.spawn(
    ["claude", "-p", "--session", sessionId, message],
    {
      cwd: WORKSPACE,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const timeout = setTimeout(() => {
    proc.kill();
  }, TIMEOUT_MS);

  try {
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode === 0) {
      return await new Response(proc.stdout).text();
    }

    const stderr = await new Response(proc.stderr).text();
    return `[Error] Claude exited with code ${exitCode}:\n${stderr}`;
  } catch {
    clearTimeout(timeout);
    return "[Error] Claude process timed out after 5 minutes.";
  }
}
