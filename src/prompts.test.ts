import { describe, expect, it } from "bun:test";
import { buildContextPrefix, escapeXml, SYSTEM_PROMPT } from "./prompts";

describe("SYSTEM_PROMPT", () => {
  it("contains key sections", () => {
    expect(SYSTEM_PROMPT).toContain("macroclaw");
    expect(SYSTEM_PROMPT).toContain("Structured output");
    expect(SYSTEM_PROMPT).toContain("Message format");
    expect(SYSTEM_PROMPT).toContain("Background agents");
    expect(SYSTEM_PROMPT).toContain("Cron");
    expect(SYSTEM_PROMPT).toContain("Buttons");
    expect(SYSTEM_PROMPT).toContain("Files");
    expect(SYSTEM_PROMPT).toContain("Session routing");
  });

  it("contains HTML formatting instructions", () => {
    expect(SYSTEM_PROMPT).toContain("HTML parse mode");
    expect(SYSTEM_PROMPT).toContain("<b>");
  });

  it("documents all source types", () => {
    expect(SYSTEM_PROMPT).toContain("cron");
    expect(SYSTEM_PROMPT).toContain("button");
    expect(SYSTEM_PROMPT).toContain("background-result");
    expect(SYSTEM_PROMPT).toContain("background-agent");
    expect(SYSTEM_PROMPT).toContain("demoted-task");
  });

  it("contains structured output reinforcement", () => {
    expect(SYSTEM_PROMPT).toContain("StructuredOutput tool");
    expect(SYSTEM_PROMPT).toContain("actionReason");
  });

  it("contains no personal names", () => {
    expect(SYSTEM_PROMPT).not.toContain("Alfread");
    expect(SYSTEM_PROMPT).not.toContain("Michal");
  });

  it("documents background agent model options", () => {
    expect(SYSTEM_PROMPT).toContain("haiku");
    expect(SYSTEM_PROMPT).toContain("sonnet");
    expect(SYSTEM_PROMPT).toContain("opus");
  });
});

describe("escapeXml", () => {
  it("escapes &, <, >, \"", () => {
    expect(escapeXml('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });

  it("returns plain text unchanged", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });
});

describe("buildContextPrefix", () => {
  it("builds user message context", () => {
    const result = buildContextPrefix({
      session: "main",
      source: { type: "user" },
      content: { tag: "prompt", text: "hello" },
    });
    expect(result).toContain('<session type="main" />');
    expect(result).toContain('<source type="user" />');
    expect(result).toContain("<prompt>hello</prompt>");
    expect(result).toStartWith("<context>");
    expect(result).toEndWith("</context>");
  });

  it("builds cron context", () => {
    const result = buildContextPrefix({
      session: "background",
      source: { type: "cron", name: "daily" },
      content: { tag: "task", text: "check updates" },
    });
    expect(result).toContain('<source type="cron" name="daily" />');
    expect(result).toContain("<task>check updates</task>");
  });

  it("builds missed cron context with attributes", () => {
    const result = buildContextPrefix({
      session: "background",
      source: { type: "cron", name: "reminder", missedBy: "15m", scheduledAt: "2026-03-20T06:00:00Z" },
      content: { tag: "task", text: "buy milk" },
    });
    expect(result).toContain('missed-by="15m"');
    expect(result).toContain('scheduled-at="2026-03-20T06:00:00Z"');
    expect(result).toContain("<task>buy milk</task>");
  });

  it("builds button context without content", () => {
    const result = buildContextPrefix({
      session: "main",
      source: { type: "button", label: "Yes" },
    });
    expect(result).toContain('<source type="button" label="Yes" />');
    expect(result).not.toContain("<prompt>");
  });

  it("builds background-agent context", () => {
    const result = buildContextPrefix({
      session: "background",
      source: { type: "background-agent", name: "research" },
      content: { tag: "task", text: "find papers" },
    });
    expect(result).toContain('<session type="background" />');
    expect(result).toContain('<source type="background-agent" name="research" />');
    expect(result).toContain("<task>find papers</task>");
  });

  it("builds background-result context", () => {
    const result = buildContextPrefix({
      session: "main",
      source: { type: "background-result", name: "research" },
      content: { tag: "result", text: "found 3 papers" },
    });
    expect(result).toContain('<source type="background-result" name="research" />');
    expect(result).toContain("<result>found 3 papers</result>");
  });

  it("builds demoted-task context", () => {
    const result = buildContextPrefix({
      session: "main",
      source: { type: "demoted-task", prompt: "long running task" },
    });
    expect(result).toContain('<source type="demoted-task" prompt="long running task" />');
  });

  it("includes files section", () => {
    const result = buildContextPrefix({
      session: "main",
      source: { type: "user" },
      files: ["/tmp/photo.jpg", "/tmp/doc.pdf"],
      content: { tag: "prompt", text: "check these" },
    });
    expect(result).toContain("<files>");
    expect(result).toContain('<file path="/tmp/photo.jpg" />');
    expect(result).toContain('<file path="/tmp/doc.pdf" />');
    expect(result).toContain("</files>");
  });

  it("escapes XML in content", () => {
    const result = buildContextPrefix({
      session: "main",
      source: { type: "user" },
      content: { tag: "prompt", text: "a < b & c > d" },
    });
    expect(result).toContain("<prompt>a &lt; b &amp; c &gt; d</prompt>");
  });

  it("escapes XML in attributes", () => {
    const result = buildContextPrefix({
      session: "main",
      source: { type: "button", label: 'a & "b"' },
    });
    expect(result).toContain('label="a &amp; &quot;b&quot;"');
  });

  it("omits content when not provided", () => {
    const result = buildContextPrefix({
      session: "main",
      source: { type: "button", label: "Ok" },
    });
    expect(result).not.toContain("<prompt>");
    expect(result).not.toContain("<task>");
    expect(result).not.toContain("<result>");
  });
});
