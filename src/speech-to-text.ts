import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import OpenAI from "openai";
import { createLogger } from "./logger";

const log = createLogger("speech-to-text");

export class SpeechToText {
  #client: OpenAI;

  constructor(apiKey: string) {
    this.#client = new OpenAI({ apiKey });
  }

  async transcribe(filePath: string): Promise<string> {
    const buffer = await readFile(filePath);
    const file = new File([buffer], basename(filePath), { type: "audio/ogg" });

    log.debug({ filePath }, "Transcribing audio");
    const result = await this.#client.audio.transcriptions.create({
      model: "whisper-1",
      file,
    });

    log.debug({ text: result.text }, "Transcription complete");
    return result.text;
  }
}
