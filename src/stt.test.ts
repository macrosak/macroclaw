import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { writeFile } from "node:fs/promises";

const mockCreate = mock(async () => ({ text: "hello world" }));

mock.module("openai", () => ({
  default: class MockOpenAI {
    audio = {
      transcriptions: {
        create: mockCreate,
      },
    };
  },
}));

const { transcribe } = await import("./stt");

const tmpFile = "/tmp/macroclaw-test-voice.ogg";

beforeEach(async () => {
  mockCreate.mockClear();
  await writeFile(tmpFile, "fake-audio-data");
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(tmpFile, { force: true });
});

describe("transcribe", () => {
  it("sends file to OpenAI and returns transcription text", async () => {
    const result = await transcribe(tmpFile);

    expect(result).toBe("hello world");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const callArgs = (mockCreate.mock.calls[0] as unknown[])[0] as any;
    expect(callArgs.model).toBe("whisper-1");
    expect(callArgs.file).toBeInstanceOf(File);
    expect(callArgs.file.name).toBe("macroclaw-test-voice.ogg");
  });

  it("propagates API errors", async () => {
    mockCreate.mockImplementationOnce(async () => {
      throw new Error("API rate limit");
    });

    expect(transcribe(tmpFile)).rejects.toThrow("API rate limit");
  });
});
