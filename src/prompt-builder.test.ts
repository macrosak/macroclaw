import { describe, expect, it } from "bun:test";
import { PromptBuilder } from "./prompt-builder";

const p = new PromptBuilder("UTC");

describe("systemPrompt", () => {
  it("contains key sections", () => {
    expect(p.systemPrompt).toContain("macroclaw");
    expect(p.systemPrompt).toContain("Structured output");
    expect(p.systemPrompt).toContain("Event format");
    expect(p.systemPrompt).toContain("Background agents");
    expect(p.systemPrompt).toContain("Cron");
    expect(p.systemPrompt).toContain("Buttons");
    expect(p.systemPrompt).toContain("Files");
    expect(p.systemPrompt).toContain("Session routing");
  });

  it("contains HTML formatting instructions", () => {
    expect(p.systemPrompt).toContain("HTML parse mode");
    expect(p.systemPrompt).toContain("<b>");
  });

  it("documents all event types", () => {
    expect(p.systemPrompt).toContain("user-message");
    expect(p.systemPrompt).toContain("button-click");
    expect(p.systemPrompt).toContain("schedule-trigger");
    expect(p.systemPrompt).toContain("background-agent-start");
    expect(p.systemPrompt).toContain("background-agent-result");
    expect(p.systemPrompt).toContain("peek");
  });

  it("documents backgrounded events", () => {
    expect(p.systemPrompt).toContain("backgrounded-event");
    expect(p.systemPrompt).toContain("moved to background");
    expect(p.systemPrompt).toContain("Do not re-execute");
  });

  it("contains structured output reinforcement", () => {
    expect(p.systemPrompt).toContain("StructuredOutput tool");
    expect(p.systemPrompt).toContain("actionReason");
  });

  it("contains no personal names", () => {
    expect(p.systemPrompt).not.toContain("Alfread");
    expect(p.systemPrompt).not.toContain("Michal");
  });

  it("documents background agent model options", () => {
    expect(p.systemPrompt).toContain("haiku");
    expect(p.systemPrompt).toContain("sonnet");
    expect(p.systemPrompt).toContain("opus");
  });

  it("includes time zone but not a fixed date", () => {
    const prague = new PromptBuilder("Europe/Prague");
    expect(prague.systemPrompt).not.toContain("Current date:");
    expect(prague.systemPrompt).toContain("Timezone: Europe/Prague");
    expect(prague.systemPrompt).toContain("TZ env var is set");
  });
});

describe("userMessage", () => {
  it("builds user message event with time attribute", () => {
    const result = p.userMessage("check-logs", "hello");
    expect(result).toMatch(/^<event time="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}" name="check-logs" type="user-message" session="main">/);
    expect(result).toContain("<text>hello</text>");
    expect(result).toEndWith("</event>");
  });

  it("builds user message with files", () => {
    const result = p.userMessage("analyze-photo", "what's in this image?", {
      files: ["/tmp/photo.jpg", "/tmp/doc.pdf"],
    });
    expect(result).toContain("<text>what's in this image?</text>");
    expect(result).toContain("<files>");
    expect(result).toContain('<file path="/tmp/photo.jpg" />');
    expect(result).toContain('<file path="/tmp/doc.pdf" />');
    expect(result).toContain("</files>");
  });

  it("builds user message with backgrounded event", () => {
    const result = p.userMessage("check-logs", "check the logs", {
      backgroundedEvent: "deploy-cluster",
    });
    expect(result).toContain('<backgrounded-event name="deploy-cluster" />');
    expect(result).toContain("<text>check the logs</text>");
  });

  it("places backgrounded-event before text", () => {
    const result = p.userMessage("check-logs", "hello", {
      backgroundedEvent: "deploy",
    });
    const bgIdx = result.indexOf("backgrounded-event");
    const textIdx = result.indexOf("<text>");
    expect(bgIdx).toBeLessThan(textIdx);
  });

  it("escapes XML in text content", () => {
    const result = p.userMessage("test", "a < b & c > d");
    expect(result).toContain("<text>a &lt; b &amp; c &gt; d</text>");
  });

  it("escapes XML in name attribute", () => {
    const result = p.userMessage('a & "b"', "test");
    expect(result).toContain('name="a &amp; &quot;b&quot;"');
  });

  it("escapes XML in backgrounded event name", () => {
    const result = p.userMessage("test", "hello", {
      backgroundedEvent: 'task & "stuff"',
    });
    expect(result).toContain('backgrounded-event name="task &amp; &quot;stuff&quot;"');
  });
});

describe("buttonClick", () => {
  it("builds button click event", () => {
    const result = p.buttonClick("btn-yes", "Yes");
    expect(result).toContain('type="button-click"');
    expect(result).toContain("<button>Yes</button>");
    expect(result).not.toContain("<text>");
  });

  it("builds button click with backgrounded event", () => {
    const result = p.buttonClick("btn-yes", "Yes", {
      backgroundedEvent: "deploy-cluster",
    });
    expect(result).toContain('<backgrounded-event name="deploy-cluster" />');
    expect(result).toContain("<button>Yes</button>");
  });

  it("escapes XML in button label", () => {
    const result = p.buttonClick("btn", 'a & "b"');
    expect(result).toContain("<button>a &amp; &quot;b&quot;</button>");
  });
});

describe("scheduleTrigger", () => {
  it("builds schedule trigger event", () => {
    const result = p.scheduleTrigger("cron-daily", { name: "daily" }, "check updates");
    expect(result).toContain('type="schedule-trigger"');
    expect(result).toContain('session="background"');
    expect(result).toContain('<schedule name="daily" />');
    expect(result).toContain("<text>check updates</text>");
  });

  it("builds missed schedule trigger with attributes", () => {
    const result = p.scheduleTrigger(
      "cron-reminder",
      { name: "reminder", missedBy: "15m", scheduledAt: "2026-03-20T06:00:00Z" },
      "buy milk",
    );
    expect(result).toContain('missed-by="15m"');
    expect(result).toContain('scheduled-at="2026-03-20T06:00:00Z"');
    expect(result).toContain("<text>buy milk</text>");
  });
});

describe("backgroundAgentStart", () => {
  it("builds background agent start event", () => {
    const result = p.backgroundAgentStart("research", "find papers about transformers");
    expect(result).toContain('type="background-agent-start"');
    expect(result).toContain('session="background"');
    expect(result).toContain("<text>find papers about transformers</text>");
  });
});

describe("backgroundAgentResult", () => {
  it("builds background agent result (text only)", () => {
    const result = p.backgroundAgentResult(
      "bg-research",
      "research",
      { action: "send", actionReason: "completed", text: "found 3 papers" },
    );
    expect(result).toContain('type="background-agent-result"');
    expect(result).toContain('<original-event name="research" />');
    expect(result).toContain('action="send"');
    expect(result).toContain('action-reason="completed"');
    expect(result).toContain("<text>found 3 papers</text>");
    expect(result).toContain("</result>");
    expect(result).not.toContain("<files>");
  });

  it("builds background agent result with files", () => {
    const result = p.backgroundAgentResult(
      "bg-research",
      "research",
      { action: "send", actionReason: "done", text: "here are the screenshots", files: ["/tmp/screenshot.png"] },
    );
    expect(result).toContain('action="send"');
    expect(result).toContain("<text>here are the screenshots</text>");
    expect(result).toContain('<file path="/tmp/screenshot.png" />');
    expect(result).toContain("</result>");
  });

  it("builds self-closing result for silent action", () => {
    const result = p.backgroundAgentResult(
      "bg-heartbeat",
      "cron-heartbeat",
      { action: "silent", actionReason: "no new results" },
    );
    expect(result).toContain('action="silent"');
    expect(result).toContain('action-reason="no new results"');
    expect(result).toContain("<result ");
    expect(result).toContain("/>");
    expect(result).not.toContain("<text>");
    expect(result).not.toContain("</result>");
  });
});

describe("backgroundAgentProgress", () => {
  it("builds progress event with progress tag", () => {
    const result = p.backgroundAgentProgress(
      "progress-research",
      "research",
      "indexing 500 documents",
      "Do not report unless important.",
    );
    expect(result).toContain('type="background-agent-progress"');
    expect(result).toContain('<original-event name="research" />');
    expect(result).toContain("<progress>indexing 500 documents</progress>");
    expect(result).not.toContain("<result>");
  });
});

describe("peek", () => {
  it("builds peek event with instructions", () => {
    const result = p.peek("peek-deploy", "deploy", "Brief status update.");
    expect(result).toContain('type="peek"');
    expect(result).toContain('<target-event name="deploy" />');
    expect(result).toContain("<instructions>Brief status update.</instructions>");
    expect(result).not.toContain("<text>");
  });
});

describe("healthCheck", () => {
  it("builds health check event with instructions", () => {
    const result = p.healthCheck("health-check-deploy", "deploy", "Report status.");
    expect(result).toContain('type="health-check"');
    expect(result).toContain('<target-event name="deploy" />');
    expect(result).toContain("<instructions>Report status.</instructions>");
  });
});
