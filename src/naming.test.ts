import { describe, expect, test } from "bun:test";
import { generateName } from "./naming";

describe("generateName", () => {
  test("extracts content words from English prompt", () => {
    expect(generateName("please research the best coffee shops in Prague")).toBe("research-best-coffee-shops");
  });

  test("extracts content words from Czech prompt", () => {
    expect(generateName("najdi nejlepsi kavárny v Praze a porovnej ceny")).toBe("najdi-nejlepsi-kavrny-praze");
  });

  test("returns 'task' for stop-words-only prompt", () => {
    expect(generateName("please do this for me")).toBe("task");
  });

  test("returns 'task' for empty prompt", () => {
    expect(generateName("")).toBe("task");
  });

  test("strips non-alphanumeric characters", () => {
    expect(generateName("fix bug #123 in auth-service!")).toBe("fix-bug-123-auth");
  });

  test("respects maxWords parameter", () => {
    expect(generateName("deploy new redis cluster with monitoring", 2)).toBe("deploy-new");
  });

  test("skips single-character words", () => {
    expect(generateName("a b c deploy x y z")).toBe("deploy");
  });

  test("handles mixed English and Czech", () => {
    expect(generateName("zkontroluj jestli je deploy hotovy")).toBe("zkontroluj-jestli-deploy-hotovy");
  });

  test("respects maxLength and drops words that would exceed it", () => {
    expect(generateName("deploy infrastructure monitoring cluster", 4, 25)).toBe("deploy-infrastructure");
  });

  test("returns 'task' for very long single nonsense word", () => {
    expect(generateName("a".repeat(500))).toBe("task");
  });
});
