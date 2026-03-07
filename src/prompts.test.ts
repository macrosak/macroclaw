import { describe, expect, it } from "bun:test";
import {
  PROMPT_BACKGROUND_RESULT,
  PROMPT_CRON_EVENT,
  PROMPT_USER_MESSAGE,
  promptBackgroundAgent,
} from "./prompts";

describe("prompts", () => {
  it("PROMPT_USER_MESSAGE contains shared intro and user context", () => {
    expect(PROMPT_USER_MESSAGE).toContain("macroclaw");
    expect(PROMPT_USER_MESSAGE).toContain("Background Agents");
    expect(PROMPT_USER_MESSAGE).toContain("Cron System");
    expect(PROMPT_USER_MESSAGE).toContain("Timeouts");
    expect(PROMPT_USER_MESSAGE).toContain("direct message from the user");
  });

  it("PROMPT_CRON_EVENT contains shared intro and cron context", () => {
    expect(PROMPT_CRON_EVENT).toContain("macroclaw");
    expect(PROMPT_CRON_EVENT).toContain("Background Agents");
    expect(PROMPT_CRON_EVENT).toContain("automated cron event");
    expect(PROMPT_CRON_EVENT).toContain("silent");
  });

  it("PROMPT_BACKGROUND_RESULT contains shared intro and bg result context", () => {
    expect(PROMPT_BACKGROUND_RESULT).toContain("macroclaw");
    expect(PROMPT_BACKGROUND_RESULT).toContain("Background Agents");
    expect(PROMPT_BACKGROUND_RESULT).toContain("background agent you previously spawned");
  });

  it("promptBackgroundAgent contains minimal intro and agent name", () => {
    const prompt = promptBackgroundAgent("research-task");
    expect(prompt).toContain("macroclaw");
    expect(prompt).toContain('"research-task"');
    expect(prompt).toContain("fed back to the main session");
    // Should NOT contain full intro sections
    expect(prompt).not.toContain("Cron System");
    expect(prompt).not.toContain("Background Agents");
    expect(prompt).toContain("30-minute timeout");
  });

  it("INTRO_FULL prompts contain HTML formatting note, background agent does not", () => {
    expect(PROMPT_USER_MESSAGE).toContain("HTML parse mode");
    expect(PROMPT_CRON_EVENT).toContain("HTML parse mode");
    expect(PROMPT_BACKGROUND_RESULT).toContain("HTML parse mode");
    expect(promptBackgroundAgent("test")).not.toContain("HTML parse mode");
  });

  it("no prompts contain personal names", () => {
    const all = [
      PROMPT_USER_MESSAGE,
      PROMPT_CRON_EVENT,
      PROMPT_BACKGROUND_RESULT,
      promptBackgroundAgent("test"),
    ];
    for (const prompt of all) {
      expect(prompt).not.toContain("Alfread");
      expect(prompt).not.toContain("Michal");
    }
  });
});
