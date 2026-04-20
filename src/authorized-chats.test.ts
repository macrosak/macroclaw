import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthorizedChats,
  DuplicateChatError,
  InvalidChatNameError,
  UnknownChatError,
} from "./authorized-chats";

const tmpDir = "/tmp/macroclaw-authorized-chats-test";

function cleanup() {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
}

beforeEach(cleanup);
afterEach(cleanup);

describe("AuthorizedChats.list", () => {
  it("returns empty array when file does not exist", () => {
    expect(new AuthorizedChats(tmpDir).list()).toEqual([]);
  });

  it("reads chats from file", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "authorized-chats.json"),
      JSON.stringify({
        chats: [
          { chatId: "-1001", name: "family", addedAt: "2026-04-20T14:00:00.000Z" },
          { chatId: "987", name: "work", addedAt: "2026-04-21T09:30:00.000Z" },
        ],
      }),
    );
    expect(new AuthorizedChats(tmpDir).list()).toEqual([
      { chatId: "-1001", name: "family", addedAt: "2026-04-20T14:00:00.000Z" },
      { chatId: "987", name: "work", addedAt: "2026-04-21T09:30:00.000Z" },
    ]);
  });

  it("returns empty array when file is corrupt", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "authorized-chats.json"), "not json");
    expect(new AuthorizedChats(tmpDir).list()).toEqual([]);
  });

  it("returns empty array when schema validation fails", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "authorized-chats.json"),
      JSON.stringify({ chats: [{ chatId: "not-numeric", name: "x", addedAt: "now" }] }),
    );
    expect(new AuthorizedChats(tmpDir).list()).toEqual([]);
  });

  it("defaults to empty chats when field is missing", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "authorized-chats.json"), JSON.stringify({}));
    expect(new AuthorizedChats(tmpDir).list()).toEqual([]);
  });
});

describe("AuthorizedChats.add", () => {
  it("persists new chat to disk", () => {
    const chats = new AuthorizedChats(tmpDir);
    const now = new Date("2026-04-20T14:00:00.000Z");
    chats.add("12345", "family", now);
    const raw = JSON.parse(readFileSync(join(tmpDir, "authorized-chats.json"), "utf-8"));
    expect(raw).toEqual({
      chats: [{ chatId: "12345", name: "family", addedAt: "2026-04-20T14:00:00.000Z" }],
    });
  });

  it("uses current time by default", () => {
    const chats = new AuthorizedChats(tmpDir);
    const chat = chats.add("12345", "family");
    expect(chat.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns the added chat", () => {
    const chats = new AuthorizedChats(tmpDir);
    const chat = chats.add("12345", "family", new Date("2026-01-01T00:00:00.000Z"));
    expect(chat).toEqual({ chatId: "12345", name: "family", addedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("rejects duplicate name", () => {
    const chats = new AuthorizedChats(tmpDir);
    chats.add("111", "family");
    expect(() => chats.add("222", "family")).toThrow(DuplicateChatError);
  });

  it("rejects duplicate chatId", () => {
    const chats = new AuthorizedChats(tmpDir);
    chats.add("111", "family");
    expect(() => chats.add("111", "work")).toThrow(DuplicateChatError);
  });

  it("rejects reserved name 'admin'", () => {
    const chats = new AuthorizedChats(tmpDir);
    expect(() => chats.add("111", "admin")).toThrow(InvalidChatNameError);
  });

  it("rejects invalid name format", () => {
    const chats = new AuthorizedChats(tmpDir);
    expect(() => chats.add("111", "Family")).toThrow(InvalidChatNameError);
    expect(() => chats.add("111", "with space")).toThrow(InvalidChatNameError);
    expect(() => chats.add("111", "")).toThrow(InvalidChatNameError);
  });

  it("accepts valid names with digits and dashes", () => {
    const chats = new AuthorizedChats(tmpDir);
    expect(() => chats.add("111", "family-1")).not.toThrow();
    expect(() => chats.add("222", "project2")).not.toThrow();
  });
});

describe("AuthorizedChats.remove", () => {
  it("removes chat and persists", () => {
    const chats = new AuthorizedChats(tmpDir);
    chats.add("111", "family");
    chats.add("222", "work");
    chats.remove("family");
    expect(chats.list().map((c) => c.name)).toEqual(["work"]);

    // Re-load from disk to confirm persistence
    const reloaded = new AuthorizedChats(tmpDir);
    expect(reloaded.list().map((c) => c.name)).toEqual(["work"]);
  });

  it("returns the removed chat", () => {
    const chats = new AuthorizedChats(tmpDir);
    const added = chats.add("111", "family");
    const removed = chats.remove("family");
    expect(removed).toEqual(added);
  });

  it("throws UnknownChatError for missing name", () => {
    const chats = new AuthorizedChats(tmpDir);
    expect(() => chats.remove("nonexistent")).toThrow(UnknownChatError);
  });
});

describe("AuthorizedChats.byName / byChatId", () => {
  it("byName finds a chat", () => {
    const chats = new AuthorizedChats(tmpDir);
    chats.add("111", "family");
    expect(chats.byName("family")?.chatId).toBe("111");
    expect(chats.byName("unknown")).toBeUndefined();
  });

  it("byChatId finds a chat", () => {
    const chats = new AuthorizedChats(tmpDir);
    chats.add("111", "family");
    expect(chats.byChatId("111")?.name).toBe("family");
    expect(chats.byChatId("999")).toBeUndefined();
  });
});

describe("AuthorizedChats.validateName", () => {
  it("throws for 'admin'", () => {
    expect(() => AuthorizedChats.validateName("admin")).toThrow(InvalidChatNameError);
  });

  it("throws for invalid characters", () => {
    expect(() => AuthorizedChats.validateName("Capital")).toThrow(InvalidChatNameError);
    expect(() => AuthorizedChats.validateName("with_underscore")).toThrow(InvalidChatNameError);
  });

  it("accepts valid names", () => {
    expect(() => AuthorizedChats.validateName("family")).not.toThrow();
    expect(() => AuthorizedChats.validateName("a-b-c")).not.toThrow();
    expect(() => AuthorizedChats.validateName("x123")).not.toThrow();
  });
});

describe("errors", () => {
  it("DuplicateChatError carries kind and value", () => {
    const err = new DuplicateChatError("name", "family");
    expect(err.kind).toBe("name");
    expect(err.value).toBe("family");
    expect(err.message).toContain("family");
  });

  it("UnknownChatError carries chatName", () => {
    const err = new UnknownChatError("ghost");
    expect(err.chatName).toBe("ghost");
    expect(err.message).toContain("ghost");
  });

  it("InvalidChatNameError carries chatName", () => {
    const err = new InvalidChatNameError("bad name", "contains space");
    expect(err.chatName).toBe("bad name");
    expect(err.message).toContain("bad name");
  });
});
