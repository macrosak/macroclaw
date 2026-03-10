/**
 * Integration test for Claude CLI structured output.
 * Run manually: bun test src/claude.integration.test.ts --timeout 120000
 */
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { type ClaudeResult, isDeferred, runClaude } from "./claude";

async function runClaudeSync(...args: Parameters<typeof runClaude>): Promise<ClaudeResult> {
  const result = await runClaude(...args);
  if (isDeferred(result)) throw new Error("Expected sync result, got deferred");
  return result;
}

const WORKSPACE = "/tmp/macroclaw-integration-test";
const SIMPLE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    action: { type: "string", enum: ["send", "silent"] },
    actionReason: { type: "string" },
    message: { type: "string" },
  },
  required: ["action", "actionReason"],
  additionalProperties: false,
});

const FULL_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    action: { type: "string", enum: ["send", "silent"], description: "'send' to reply to the user, 'silent' to do nothing" },
    actionReason: { type: "string", description: "Why the agent chose this action (logged, not sent)" },
    message: { type: "string", description: "The message to send to Telegram (required when action is 'send')" },
    files: { type: "array", items: { type: "string" }, description: "Absolute paths to files to send to Telegram" },
    backgroundAgents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          prompt: { type: "string" },
          model: { type: "string", enum: ["haiku", "sonnet", "opus"] },
        },
        required: ["name", "prompt"],
        additionalProperties: false,
      },
    },
  },
  required: ["action", "actionReason"],
  additionalProperties: false,
});

describe("claude CLI structured output", () => {
  it("simple schema without system prompt", async () => {
    const result = await runClaudeSync({
      prompt: "Say hello",
      sessionFlag: "--session-id",
      sessionId: randomUUID(),
      model: "haiku",
      workspace: WORKSPACE,
      jsonSchema: SIMPLE_SCHEMA,
    });

    console.log("Simple (no sysprompt):", JSON.stringify(result, null, 2));
    expect(result.structuredOutput).not.toBeNull();
  }, 60_000);

  it("simple schema with system prompt", async () => {
    const result = await runClaudeSync({
      prompt: "Say hello",
      sessionFlag: "--session-id",
      sessionId: randomUUID(),
      model: "haiku",
      workspace: WORKSPACE,
      systemPrompt: "You are a helpful assistant. This is a direct message from the user.",
      jsonSchema: SIMPLE_SCHEMA,
    });

    console.log("Simple (with sysprompt):", JSON.stringify(result, null, 2));
    expect(result.structuredOutput).not.toBeNull();
  }, 60_000);

  it("full schema with system prompt", async () => {
    const result = await runClaudeSync({
      prompt: "Say hello",
      sessionFlag: "--session-id",
      sessionId: randomUUID(),
      model: "haiku",
      workspace: WORKSPACE,
      systemPrompt: "You are a helpful assistant. This is a direct message from the user.",
      jsonSchema: FULL_SCHEMA,
    });

    console.log("Full (with sysprompt):", JSON.stringify(result, null, 2));
    expect(result.structuredOutput).not.toBeNull();
  }, 60_000);

  it("full schema with real system prompt and workspace", async () => {
    const result = await runClaudeSync({
      prompt: "Say hello",
      sessionFlag: "--session-id",
      sessionId: randomUUID(),
      model: "sonnet",
      workspace: process.env.MACROCLAW_WORKSPACE ?? WORKSPACE,
      systemPrompt: `You are an AI assistant running inside macroclaw. This is a direct message from the user.`,
      jsonSchema: FULL_SCHEMA,
    });

    console.log("Full (real workspace):", JSON.stringify(result, null, 2));
    expect(result.structuredOutput).not.toBeNull();
  }, 120_000);
});
