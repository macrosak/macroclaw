import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bot, InputFile } from "grammy";
import { createLogger } from "./logger";

const log = createLogger("telegram");

const MAX_LENGTH = 4096;
const INBOUND_DIR = "/tmp/macroclaw/inbound";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function createBot(token: string) {
  return new Bot(token);
}

export async function sendResponse(
  bot: Bot,
  chatId: string,
  text: string,
): Promise<void> {
  const opts = { parse_mode: "HTML" as const };

  if (text.length <= MAX_LENGTH) {
    await bot.api.sendMessage(chatId, text, opts);
    return;
  }

  // Split at line boundaries into chunks <= MAX_LENGTH
  const lines = text.split("\n");
  let chunk = "";

  for (const line of lines) {
    // If a single line exceeds MAX_LENGTH, hard-split it
    if (line.length > MAX_LENGTH) {
      if (chunk) {
        await bot.api.sendMessage(chatId, chunk, opts);
        chunk = "";
      }
      for (let i = 0; i < line.length; i += MAX_LENGTH) {
        await bot.api.sendMessage(chatId, line.slice(i, i + MAX_LENGTH), opts);
      }
      continue;
    }

    const candidate = chunk ? `${chunk}\n${line}` : line;
    if (candidate.length > MAX_LENGTH) {
      await bot.api.sendMessage(chatId, chunk, opts);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }

  if (chunk) {
    await bot.api.sendMessage(chatId, chunk, opts);
  }
}

export async function downloadFile(
  bot: Bot,
  fileId: string,
  token: string,
  originalName?: string,
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("Telegram returned no file_path");

  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const dir = join(INBOUND_DIR, randomUUID());
  await mkdir(dir, { recursive: true });
  const name = originalName ?? filePath.split("/").pop() ?? "file";
  const dest = join(dir, name);
  await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
  return dest;
}

function extName(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

export async function sendFile(
  bot: Bot,
  chatId: string,
  filePath: string,
): Promise<void> {
  if (!existsSync(filePath)) {
    log.warn({ filePath }, "File not found, skipping");
    return;
  }

  const ext = extName(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) {
    await bot.api.sendPhoto(chatId, new InputFile(filePath));
  } else {
    await bot.api.sendDocument(chatId, new InputFile(filePath));
  }
}
