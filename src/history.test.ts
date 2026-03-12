import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { writeHistoryPrompt, writeHistoryResult } from "./history";

const mockMkdir = spyOn(fs, "mkdir").mockResolvedValue(undefined);
const mockAppendFile = spyOn(fs, "appendFile").mockResolvedValue(undefined);

beforeEach(() => {
  mockMkdir.mockClear();
  mockAppendFile.mockClear();
});

afterAll(() => {
  mockMkdir.mockRestore();
  mockAppendFile.mockRestore();
});

describe("writeHistoryPrompt", () => {
  it("writes a prompt entry as JSONL", async () => {
    const request = { type: "user", message: "hello" };
    await writeHistoryPrompt(request);

    expect(mockMkdir).toHaveBeenCalledTimes(1);
    expect(mockMkdir.mock.calls[0][1]).toEqual({ recursive: true });

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const written = mockAppendFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.type).toBe("prompt");
    expect(parsed.request).toEqual(request);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes cron request", async () => {
    const request = { type: "cron", name: "daily", prompt: "check" };
    await writeHistoryPrompt(request);

    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(parsed.request).toEqual(request);
  });
});

describe("writeHistoryResult", () => {
  it("writes a result entry as JSONL", async () => {
    const response = { action: "send", message: "hi", actionReason: "ok" };
    await writeHistoryResult(response);

    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    const written = mockAppendFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.type).toBe("result");
    expect(parsed.response).toEqual(response);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes silent response", async () => {
    const response = { action: "silent", actionReason: "nothing new" };
    await writeHistoryResult(response);

    const parsed = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(parsed.response).toEqual(response);
  });
});

describe("file path", () => {
  it("uses today's date in YYYY-MM-DD.jsonl format", async () => {
    await writeHistoryPrompt({ type: "user", message: "test" });

    const filePath = mockAppendFile.mock.calls[0][0] as string;
    const today = new Date().toISOString().slice(0, 10);
    expect(filePath).toContain(`${today}.jsonl`);
    expect(filePath).toContain(".macroclaw/history/");
  });
});

describe("mkdir", () => {
  it("creates history directory recursively", async () => {
    await writeHistoryPrompt({ type: "user", message: "test" });

    const dirPath = mockMkdir.mock.calls[0][0] as string;
    expect(dirPath).toContain(".macroclaw/history");
  });
});

describe("error handling", () => {
  it("logs errors but does not throw", async () => {
    mockAppendFile.mockRejectedValueOnce(new Error("disk full"));

    // Should not throw
    await writeHistoryPrompt({ type: "user", message: "test" });
  });
});
