import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("authorized-chats");

export const ADMIN_CHAT_NAME = "admin";
const NAME_PATTERN = /^[a-z0-9-]+$/;

const chatSchema = z.object({
  chatId: z.string().regex(/^-?\d+$/, "Must be a numeric Telegram chat ID"),
  name: z.string().regex(NAME_PATTERN, "Name must be lowercase alphanumeric or dashes"),
  addedAt: z.string(),
});

const fileSchema = z.object({
  chats: z.array(chatSchema).default([]),
});

export type AuthorizedChat = z.infer<typeof chatSchema>;
export type AuthorizedChatsFile = z.infer<typeof fileSchema>;

const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

export class DuplicateChatError extends Error {
  constructor(public readonly kind: "name" | "chatId", public readonly value: string) {
    super(`Chat with ${kind} "${value}" is already authorized`);
  }
}

export class InvalidChatNameError extends Error {
  constructor(public readonly chatName: string, reason: string) {
    super(`Invalid chat name "${chatName}": ${reason}`);
  }
}

export class UnknownChatError extends Error {
  constructor(public readonly chatName: string) {
    super(`No authorized chat named "${chatName}"`);
  }
}

export class AuthorizedChats {
  readonly #dir: string;
  #chats: AuthorizedChat[] = [];

  constructor(dir: string = defaultDir) {
    this.#dir = dir;
    this.#chats = this.#loadFromDisk();
  }

  list(): readonly AuthorizedChat[] {
    return this.#chats;
  }

  byName(name: string): AuthorizedChat | undefined {
    return this.#chats.find((c) => c.name === name);
  }

  byChatId(chatId: string): AuthorizedChat | undefined {
    return this.#chats.find((c) => c.chatId === chatId);
  }

  add(chatId: string, name: string, now: Date = new Date()): AuthorizedChat {
    AuthorizedChats.validateName(name);

    if (this.byName(name)) throw new DuplicateChatError("name", name);
    if (this.byChatId(chatId)) throw new DuplicateChatError("chatId", chatId);

    const chat = chatSchema.parse({ chatId, name, addedAt: now.toISOString() });
    this.#chats.push(chat);
    this.#persist();
    return chat;
  }

  remove(name: string): AuthorizedChat {
    const existing = this.byName(name);
    if (!existing) throw new UnknownChatError(name);
    this.#chats = this.#chats.filter((c) => c.name !== name);
    this.#persist();
    return existing;
  }

  static validateName(name: string): void {
    if (name === ADMIN_CHAT_NAME) {
      throw new InvalidChatNameError(name, `"${ADMIN_CHAT_NAME}" is reserved`);
    }
    if (!NAME_PATTERN.test(name)) {
      throw new InvalidChatNameError(name, "must be lowercase alphanumeric or dashes");
    }
  }

  #loadFromDisk(): AuthorizedChat[] {
    const path = this.#path();
    if (!existsSync(path)) return [];
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const result = fileSchema.safeParse(raw);
      if (!result.success) {
        log.warn(
          { issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
          "authorized-chats.json validation failed; starting with empty list",
        );
        return [];
      }
      return result.data.chats;
    } catch (err) {
      log.warn({ err }, "Failed to load authorized-chats.json; starting with empty list");
      return [];
    }
  }

  #persist(): void {
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(this.#path(), `${JSON.stringify({ chats: this.#chats }, null, 2)}\n`);
  }

  #path(): string {
    return join(this.#dir, "authorized-chats.json");
  }
}
