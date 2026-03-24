/**
 * Integration test for Claude CLI structured output.
 * Run manually: bun test src/claude.integration-test.ts --timeout 120000
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod/v4";
import { Claude } from "./claude";

const WORKSPACE = "/tmp/macroclaw-integration-test";

const simpleSchema = z.object({
  action: z.enum(["send", "silent"]),
  actionReason: z.string(),
  message: z.string().optional(),
});

const fullSchema = z.object({
  action: z.enum(["send", "silent"]),
  actionReason: z.string(),
  message: z.string().optional(),
  files: z.array(z.string()).optional(),
  backgroundAgents: z.array(z.object({
    name: z.string(),
    prompt: z.string(),
    model: z.enum(["haiku", "sonnet", "opus"]).optional(),
  })).optional(),
});

function objectResultType<T>(schema: z.ZodType<T>) {
  return { type: "object" as const, schema };
}
const textResultType = { type: "text" } as const;

describe("stream-json persistent process", () => {
  it("receives structured output via stream-json with single send", async () => {
    const claude = new Claude({ workspace: WORKSPACE });
    const process = claude.newSession(objectResultType(simpleSchema), { model: "haiku" });

    const { value } = await process.send("Say hello briefly");

    console.log("Stream-json structured output:", JSON.stringify(value, null, 2));
    expect(value).not.toBeNull();
    expect(value.action).toBeDefined();

    await process.kill();
  }, 60_000);

  it("receives text output via stream-json", async () => {
    const claude = new Claude({ workspace: WORKSPACE });
    const process = claude.newSession(textResultType, { model: "haiku" });

    const { value } = await process.send("Say hello in one word");

    console.log("Stream-json text output:", value);
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(0);

    await process.kill();
  }, 60_000);

  it("supports multiple sends to the same process (persistent)", async () => {
    const claude = new Claude({ workspace: WORKSPACE });
    const process = claude.newSession(objectResultType(simpleSchema), { model: "haiku" });

    // First message
    const r1 = await process.send("Say hello");
    console.log("First response:", JSON.stringify(r1.value, null, 2));
    expect(r1.value.action).toBeDefined();

    // Second message — same process, same session
    const r2 = await process.send("Say goodbye");
    console.log("Second response:", JSON.stringify(r2.value, null, 2));
    expect(r2.value.action).toBeDefined();

    // Session IDs should match (same session)
    expect(r1.sessionId).toBe(r2.sessionId);

    await process.kill();
  }, 120_000);

  it("full schema with system prompt", async () => {
    const claude = new Claude({ workspace: WORKSPACE });
    const process = claude.newSession(
      objectResultType(fullSchema),
      { model: "haiku", systemPrompt: "You are a helpful assistant. This is a direct message from the user." },
    );

    const { value } = await process.send("Say hello");

    console.log("Full schema (with sysprompt):", JSON.stringify(value, null, 2));
    expect(value).not.toBeNull();

    await process.kill();
  }, 60_000);

  it("resume session works with stream-json", async () => {
    const claude = new Claude({ workspace: WORKSPACE });

    // Create a session
    const p1 = claude.newSession(objectResultType(simpleSchema), { model: "haiku" });
    const r1 = await p1.send("Remember the word 'banana'");
    const sessionId = r1.sessionId;
    console.log("Created session:", sessionId);
    await p1.kill();

    // Resume the session in a new process
    const p2 = claude.resumeSession(sessionId, objectResultType(simpleSchema), { model: "haiku" });
    const r2 = await p2.send("What word did I ask you to remember?");
    console.log("Resumed response:", JSON.stringify(r2.value, null, 2));
    expect(r2.value.action).toBeDefined();

    await p2.kill();
  }, 120_000);
});
