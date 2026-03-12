import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { createLogger } from "./logger";

export type ButtonSpec = string | { text: string; data: string };

const log = createLogger("telegram");

const MAX_LENGTH = 4096;
const INBOUND_DIR = "/tmp/macroclaw/inbound";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function createBot(token: string) {
  return new Bot(token);
}

export function buildInlineKeyboard(buttons: ButtonSpec[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < buttons.length; i++) {
    if (i > 0) kb.row();
    const b = buttons[i];
    if (typeof b === "string") {
      kb.text(b, b);
    } else {
      kb.text(b.text, b.data);
    }
  }
  return kb;
}

export async function sendResponse(
  bot: Bot,
  chatId: string,
  text: string,
  buttons?: ButtonSpec[],
): Promise<void> {
  const opts = { parse_mode: "HTML" as const };
  const replyMarkup = buttons?.length ? buildInlineKeyboard(buttons) : undefined;

  if (text.length <= MAX_LENGTH) {
    await bot.api.sendMessage(chatId, text, { ...opts, reply_markup: replyMarkup });
    return;
  }

  // Split at line boundaries into chunks <= MAX_LENGTH
  const lines = text.split("\n");
  const chunks: string[] = [];
  let chunk = "";

  for (const line of lines) {
    if (line.length > MAX_LENGTH) {
      if (chunk) {
        chunks.push(chunk);
        chunk = "";
      }
      for (let i = 0; i < line.length; i += MAX_LENGTH) {
        chunks.push(line.slice(i, i + MAX_LENGTH));
      }
      continue;
    }

    const candidate = chunk ? `${chunk}\n${line}` : line;
    if (candidate.length > MAX_LENGTH) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }

  if (chunk) {
    chunks.push(chunk);
  }

  // Send all chunks; attach buttons to the last one only
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await bot.api.sendMessage(chatId, chunks[i], { ...opts, reply_markup: isLast ? replyMarkup : undefined });
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
