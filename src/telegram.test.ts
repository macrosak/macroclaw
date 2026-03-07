import { describe, expect, it, mock } from "bun:test";
import { createBot, sendResponse } from "./telegram";

// Mock bot API
function mockBot() {
  const calls: { chatId: string; text: string; opts?: any }[] = [];
  return {
    api: {
      sendMessage: mock(async (chatId: string, text: string, opts?: any) => {
        calls.push({ chatId, text, opts });
      }),
    },
    calls,
  } as any;
}

describe("createBot", () => {
  it("returns a Grammy Bot instance", () => {
    // Can't fully test without a real token, but verify it returns an object
    const bot = createBot("test-token");
    expect(bot).toBeDefined();
    expect(bot.api).toBeDefined();
  });
});

describe("sendResponse", () => {
  it("sends short messages in a single call", async () => {
    const bot = mockBot();
    await sendResponse(bot, "123", "Hello");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.calls[0]).toEqual({ chatId: "123", text: "Hello", opts: { parse_mode: "HTML" } });
  });

  it("sends messages at exactly 4096 chars in a single call", async () => {
    const bot = mockBot();
    const text = "x".repeat(4096);
    await sendResponse(bot, "123", text);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("splits long messages at line boundaries", async () => {
    const bot = mockBot();
    // Create text with lines that force a split
    const line = "a".repeat(2000);
    const text = `${line}\n${line}\n${line}`; // 6002 chars total
    await sendResponse(bot, "123", text);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    // First chunk: line1 + \n + line2 = 4001 chars
    expect(bot.calls[0].text).toBe(`${line}\n${line}`);
    // Second chunk: line3 = 2000 chars
    expect(bot.calls[1].text).toBe(line);
  });

  it("hard-splits single lines exceeding 4096 chars", async () => {
    const bot = mockBot();
    const longLine = "z".repeat(5000);
    await sendResponse(bot, "123", longLine);
    // Split into 4096 + 904
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.calls[0].text).toBe("z".repeat(4096));
    expect(bot.calls[1].text).toBe("z".repeat(904));
  });

  it("handles long line preceded by a buffered chunk", async () => {
    const bot = mockBot();
    const shortLine = "short";
    const longLine = "z".repeat(5000);
    const text = `${shortLine}\n${longLine}`;
    await sendResponse(bot, "123", text);
    // 1: "short", 2: first 4096 of longLine, 3: remaining 904
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(bot.calls[0].text).toBe("short");
    expect(bot.calls[1].text).toBe("z".repeat(4096));
    expect(bot.calls[2].text).toBe("z".repeat(904));
  });

  it("handles line that exactly causes overflow", async () => {
    const bot = mockBot();
    const line1 = "a".repeat(4000);
    const line2 = "b".repeat(200); // 4000 + 1 (newline) + 200 = 4201 > 4096
    const text = `${line1}\n${line2}`;
    await sendResponse(bot, "123", text);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.calls[0].text).toBe(line1);
    expect(bot.calls[1].text).toBe(line2);
  });

  it("sends empty trailing chunk correctly", async () => {
    const bot = mockBot();
    await sendResponse(bot, "123", "hello\nworld");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.calls[0].text).toBe("hello\nworld");
  });
});
