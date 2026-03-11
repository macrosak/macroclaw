import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import OpenAI from "openai";
import { createLogger } from "./logger";

const log = createLogger("stt");

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export async function transcribe(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const file = new File([buffer], basename(filePath), { type: "audio/ogg" });

  log.debug({ filePath }, "Transcribing audio");
  const result = await getClient().audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  log.debug({ text: result.text }, "Transcription complete");
  return result.text;
}
