import { describe, expect, it } from "bun:test";
import { SYSTEM_PROMPT } from "./prompts";

describe("SYSTEM_PROMPT", () => {
  it("contains key sections", () => {
    expect(SYSTEM_PROMPT).toContain("macroclaw");
    expect(SYSTEM_PROMPT).toContain("Structured output");
    expect(SYSTEM_PROMPT).toContain("Context tags");
    expect(SYSTEM_PROMPT).toContain("Background agents");
    expect(SYSTEM_PROMPT).toContain("Cron");
    expect(SYSTEM_PROMPT).toContain("Buttons");
    expect(SYSTEM_PROMPT).toContain("Files");
    expect(SYSTEM_PROMPT).toContain("Timeouts");
  });

  it("contains HTML formatting instructions", () => {
    expect(SYSTEM_PROMPT).toContain("HTML parse mode");
    expect(SYSTEM_PROMPT).toContain("<b>");
  });

  it("documents all context tag types", () => {
    expect(SYSTEM_PROMPT).toContain("cron/<name>");
    expect(SYSTEM_PROMPT).toContain("button-click");
    expect(SYSTEM_PROMPT).toContain("background-result/<name>");
    expect(SYSTEM_PROMPT).toContain("background-agent/<name>");
  });

  it("contains structured output reinforcement", () => {
    expect(SYSTEM_PROMPT).toContain("StructuredOutput tool");
    expect(SYSTEM_PROMPT).toContain("actionReason");
  });

  it("contains no personal names", () => {
    expect(SYSTEM_PROMPT).not.toContain("Alfread");
    expect(SYSTEM_PROMPT).not.toContain("Michal");
  });

  it("documents background agent model options", () => {
    expect(SYSTEM_PROMPT).toContain("haiku");
    expect(SYSTEM_PROMPT).toContain("sonnet");
    expect(SYSTEM_PROMPT).toContain("opus");
  });
});
