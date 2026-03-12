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

const objectResultType = (schema: z.ZodType) => ({ type: "object" as const, schema });

describe("claude CLI structured output", () => {
  it("simple schema without system prompt", async () => {
    const claude = new Claude({ workspace: WORKSPACE });
    const { value } = await claude.newSession("Say hello", objectResultType(simpleSchema), { model: "haiku" }).result;

    console.log("Simple (no sysprompt):", JSON.stringify(value, null, 2));
    expect(value).not.toBeNull();
  }, 60_000);

  it("simple schema with system prompt", async () => {
    const claude = new Claude({ workspace: WORKSPACE });
    const { value } = await claude.newSession(
      "Say hello",
      objectResultType(simpleSchema),
      { model: "haiku", systemPrompt: "You are a helpful assistant. This is a direct message from the user." },
    ).result;

    console.log("Simple (with sysprompt):", JSON.stringify(value, null, 2));
    expect(value).not.toBeNull();
  }, 60_000);

  it("full schema with system prompt", async () => {
    const claude = new Claude({ workspace: WORKSPACE });
    const { value } = await claude.newSession(
      "Say hello",
      objectResultType(fullSchema),
      { model: "haiku", systemPrompt: "You are a helpful assistant. This is a direct message from the user." },
    ).result;

    console.log("Full (with sysprompt):", JSON.stringify(value, null, 2));
    expect(value).not.toBeNull();
  }, 60_000);

  it("full schema with real system prompt and workspace", async () => {
    const workspace = process.env.MACROCLAW_WORKSPACE ?? WORKSPACE;
    const claude = new Claude({ workspace });
    const { value } = await claude.newSession(
      "Say hello",
      objectResultType(fullSchema),
      { model: "sonnet", systemPrompt: "You are an AI assistant running inside macroclaw. This is a direct message from the user." },
    ).result;

    console.log("Full (real workspace):", JSON.stringify(value, null, 2));
    expect(value).not.toBeNull();
  }, 120_000);
});
