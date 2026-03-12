import { describe, expect, it, mock } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { buildInlineKeyboard, createBot, downloadFile, sendFile, sendResponse } from "./telegram";

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

  it("attaches buttons to a single message", async () => {
    const bot = mockBot();
    const buttons = ["Yes", "No"];
    await sendResponse(bot, "123", "Choose:", buttons);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.calls[0].opts.reply_markup).toBeDefined();
  });

  it("attaches buttons to last chunk only when splitting", async () => {
    const bot = mockBot();
    const line = "a".repeat(2000);
    const text = `${line}\n${line}\n${line}`;
    const buttons = ["Ok"];
    await sendResponse(bot, "123", text, buttons);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    // First chunk: no buttons
    expect(bot.calls[0].opts.reply_markup).toBeUndefined();
    // Last chunk: has buttons
    expect(bot.calls[1].opts.reply_markup).toBeDefined();
  });

  it("sends without keyboard when buttons is empty", async () => {
    const bot = mockBot();
    await sendResponse(bot, "123", "Hello", []);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.calls[0].opts.reply_markup).toBeUndefined();
  });
});

describe("buildInlineKeyboard", () => {
  it("builds keyboard with rows and buttons", () => {
    const kb = buildInlineKeyboard(["A", "B", "C"]);
    expect(kb).toBeDefined();
    // InlineKeyboard from grammy — verify it's an object with inline_keyboard
    expect(kb.inline_keyboard).toBeDefined();
    expect(kb.inline_keyboard.length).toBe(3);
    expect(kb.inline_keyboard[0].length).toBe(1);
    const btn = kb.inline_keyboard[0][0] as any;
    expect(btn.text).toBe("A");
    expect(btn.callback_data).toBe("A");
    expect((kb.inline_keyboard[2][0] as any).text).toBe("C");
  });

  it("supports object buttons with separate text and data", () => {
    const kb = buildInlineKeyboard([
      { text: "Peek agent-1 (30s)", data: "peek:session-123" },
      "_dismiss",
    ]);
    expect(kb.inline_keyboard.length).toBe(2);
    const peekBtn = kb.inline_keyboard[0][0] as any;
    expect(peekBtn.text).toBe("Peek agent-1 (30s)");
    expect(peekBtn.callback_data).toBe("peek:session-123");
    const dismissBtn = kb.inline_keyboard[1][0] as any;
    expect(dismissBtn.text).toBe("_dismiss");
    expect(dismissBtn.callback_data).toBe("_dismiss");
  });
});

describe("downloadFile", () => {
  it("downloads file to /tmp/macroclaw/inbound/<uuid>/<name>", async () => {
    const fileContent = new Uint8Array([1, 2, 3]);
    const mockFetch = mock(() =>
      Promise.resolve(new Response(fileContent, { status: 200 })),
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    const bot = {
      api: {
        getFile: mock(async () => ({ file_path: "photos/file_42.jpg" })),
      },
    } as any;

    const path = await downloadFile(bot, "file-id-123", "123:ABC", "photo.jpg");

    expect(path).toContain("/tmp/macroclaw/inbound/");
    expect(path).toEndWith("/photo.jpg");
    expect(existsSync(path)).toBe(true);

    const contents = await readFile(path);
    expect(new Uint8Array(contents)).toEqual(fileContent);

    const fetchUrl = (mockFetch as any).mock.calls[0][0];
    expect(fetchUrl).toBe("https://api.telegram.org/file/bot123:ABC/photos/file_42.jpg");

    // Cleanup
    await rm(path, { force: true });
    globalThis.fetch = origFetch;
  });

  it("uses file_path basename when no originalName given", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("data", { status: 200 })),
    ) as any;

    const bot = {
      api: {
        getFile: mock(async () => ({ file_path: "documents/report.pdf" })),
      },
    } as any;

    const path = await downloadFile(bot, "file-id", "token");
    expect(path).toEndWith("/report.pdf");

    await rm(path, { force: true });
    globalThis.fetch = origFetch;
  });

  it("throws when Telegram returns no file_path", async () => {
    const bot = {
      api: { getFile: mock(async () => ({})) },
    } as any;

    expect(downloadFile(bot, "file-id", "token")).rejects.toThrow("no file_path");
  });

  it("throws when download fails", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("", { status: 404 })),
    ) as any;

    const bot = {
      api: { getFile: mock(async () => ({ file_path: "photos/x.jpg" })) },
    } as any;

    expect(downloadFile(bot, "file-id", "token")).rejects.toThrow("Download failed: 404");
    globalThis.fetch = origFetch;
  });
});

describe("sendFile", () => {
  it("sends image extensions as photos", async () => {
    const tmpFile = `/tmp/macroclaw-test-${Date.now()}.png`;
    await Bun.write(tmpFile, "fake png");

    const bot = {
      api: {
        sendPhoto: mock(async () => {}),
        sendDocument: mock(async () => {}),
      },
    } as any;

    await sendFile(bot, "123", tmpFile);
    expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(bot.api.sendDocument).not.toHaveBeenCalled();

    await rm(tmpFile, { force: true });
  });

  it("sends non-image extensions as documents", async () => {
    const tmpFile = `/tmp/macroclaw-test-${Date.now()}.pdf`;
    await Bun.write(tmpFile, "fake pdf");

    const bot = {
      api: {
        sendPhoto: mock(async () => {}),
        sendDocument: mock(async () => {}),
      },
    } as any;

    await sendFile(bot, "123", tmpFile);
    expect(bot.api.sendDocument).toHaveBeenCalledTimes(1);
    expect(bot.api.sendPhoto).not.toHaveBeenCalled();

    await rm(tmpFile, { force: true });
  });

  it("skips missing files without sending", async () => {
    const bot = {
      api: {
        sendPhoto: mock(async () => {}),
        sendDocument: mock(async () => {}),
      },
    } as any;

    await sendFile(bot, "123", "/tmp/nonexistent-file-xyz.txt");
    expect(bot.api.sendPhoto).not.toHaveBeenCalled();
    expect(bot.api.sendDocument).not.toHaveBeenCalled();
  });

  for (const ext of [".jpg", ".jpeg", ".gif", ".webp"]) {
    it(`treats ${ext} as image`, async () => {
      const tmpFile = `/tmp/macroclaw-test-${Date.now()}${ext}`;
      await Bun.write(tmpFile, "fake");

      const bot = {
        api: {
          sendPhoto: mock(async () => {}),
          sendDocument: mock(async () => {}),
        },
      } as any;

      await sendFile(bot, "123", tmpFile);
      expect(bot.api.sendPhoto).toHaveBeenCalledTimes(1);

      await rm(tmpFile, { force: true });
    });
  }
});
