import { Bot } from "grammy";

const MAX_LENGTH = 4096;

export function createBot(token: string) {
  return new Bot(token);
}

export async function sendResponse(
  bot: Bot,
  chatId: string,
  text: string,
): Promise<void> {
  if (text.length <= MAX_LENGTH) {
    await bot.api.sendMessage(chatId, text);
    return;
  }

  // Split at line boundaries into chunks <= MAX_LENGTH
  const lines = text.split("\n");
  let chunk = "";

  for (const line of lines) {
    // If a single line exceeds MAX_LENGTH, hard-split it
    if (line.length > MAX_LENGTH) {
      if (chunk) {
        await bot.api.sendMessage(chatId, chunk);
        chunk = "";
      }
      for (let i = 0; i < line.length; i += MAX_LENGTH) {
        await bot.api.sendMessage(chatId, line.slice(i, i + MAX_LENGTH));
      }
      continue;
    }

    const candidate = chunk ? chunk + "\n" + line : line;
    if (candidate.length > MAX_LENGTH) {
      await bot.api.sendMessage(chatId, chunk);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }

  if (chunk) {
    await bot.api.sendMessage(chatId, chunk);
  }
}
