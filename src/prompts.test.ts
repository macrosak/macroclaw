import { describe, expect, it } from "bun:test";
import {
  backgroundAgentProgressEvent,
  backgroundAgentResultEvent,
  backgroundAgentStartEvent,
  buttonClickEvent,
  healthCheckEvent,
  peekEvent,
  SYSTEM_PROMPT,
  scheduleTriggerEvent,
  userMessageEvent,
} from "./prompts";

describe("SYSTEM_PROMPT", () => {
  it("contains key sections", () => {
    expect(SYSTEM_PROMPT).toContain("macroclaw");
    expect(SYSTEM_PROMPT).toContain("Structured output");
    expect(SYSTEM_PROMPT).toContain("Event format");
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

  it("documents all event types", () => {
    expect(SYSTEM_PROMPT).toContain("user-message");
    expect(SYSTEM_PROMPT).toContain("button-click");
    expect(SYSTEM_PROMPT).toContain("schedule-trigger");
    expect(SYSTEM_PROMPT).toContain("background-agent-start");
    expect(SYSTEM_PROMPT).toContain("background-agent-result");
    expect(SYSTEM_PROMPT).toContain("peek");
  });

  it("documents backgrounded events", () => {
    expect(SYSTEM_PROMPT).toContain("backgrounded-event");
    expect(SYSTEM_PROMPT).toContain("moved to background");
    expect(SYSTEM_PROMPT).toContain("Do not re-execute");
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

describe("userMessageEvent", () => {
  it("builds user message event", () => {
    const result = userMessageEvent("check-logs", "hello");
    expect(result).toStartWith('<event name="check-logs" type="user-message" session="main">');
    expect(result).toContain("<text>hello</text>");
    expect(result).toEndWith("</event>");
  });

  it("builds user message with files", () => {
    const result = userMessageEvent("analyze-photo", "what's in this image?", {
      files: ["/tmp/photo.jpg", "/tmp/doc.pdf"],
    });
    expect(result).toContain("<text>what's in this image?</text>");
    expect(result).toContain("<files>");
    expect(result).toContain('<file path="/tmp/photo.jpg" />');
    expect(result).toContain('<file path="/tmp/doc.pdf" />');
    expect(result).toContain("</files>");
  });

  it("builds user message with backgrounded event", () => {
    const result = userMessageEvent("check-logs", "check the logs", {
      backgroundedEvent: "deploy-cluster",
    });
    expect(result).toContain('<backgrounded-event name="deploy-cluster" />');
    expect(result).toContain("<text>check the logs</text>");
  });

  it("places backgrounded-event before text", () => {
    const result = userMessageEvent("check-logs", "hello", {
      backgroundedEvent: "deploy",
    });
    const bgIdx = result.indexOf("backgrounded-event");
    const textIdx = result.indexOf("<text>");
    expect(bgIdx).toBeLessThan(textIdx);
  });

  it("escapes XML in text content", () => {
    const result = userMessageEvent("test", "a < b & c > d");
    expect(result).toContain("<text>a &lt; b &amp; c &gt; d</text>");
  });

  it("escapes XML in name attribute", () => {
    const result = userMessageEvent('a & "b"', "test");
    expect(result).toContain('name="a &amp; &quot;b&quot;"');
  });

  it("escapes XML in backgrounded event name", () => {
    const result = userMessageEvent("test", "hello", {
      backgroundedEvent: 'task & "stuff"',
    });
    expect(result).toContain('backgrounded-event name="task &amp; &quot;stuff&quot;"');
  });
});

describe("buttonClickEvent", () => {
  it("builds button click event", () => {
    const result = buttonClickEvent("btn-yes", "Yes");
    expect(result).toContain('type="button-click"');
    expect(result).toContain("<button>Yes</button>");
    expect(result).not.toContain("<text>");
  });

  it("builds button click with backgrounded event", () => {
    const result = buttonClickEvent("btn-yes", "Yes", {
      backgroundedEvent: "deploy-cluster",
    });
    expect(result).toContain('<backgrounded-event name="deploy-cluster" />');
    expect(result).toContain("<button>Yes</button>");
  });

  it("escapes XML in button label", () => {
    const result = buttonClickEvent("btn", 'a & "b"');
    expect(result).toContain("<button>a &amp; &quot;b&quot;</button>");
  });
});

describe("scheduleTriggerEvent", () => {
  it("builds schedule trigger event", () => {
    const result = scheduleTriggerEvent("cron-daily", { name: "daily" }, "check updates");
    expect(result).toContain('type="schedule-trigger"');
    expect(result).toContain('session="background"');
    expect(result).toContain('<schedule name="daily" />');
    expect(result).toContain("<text>check updates</text>");
  });

  it("builds missed schedule trigger with attributes", () => {
    const result = scheduleTriggerEvent(
      "cron-reminder",
      { name: "reminder", missedBy: "15m", scheduledAt: "2026-03-20T06:00:00Z" },
      "buy milk",
    );
    expect(result).toContain('missed-by="15m"');
    expect(result).toContain('scheduled-at="2026-03-20T06:00:00Z"');
    expect(result).toContain("<text>buy milk</text>");
  });
});

describe("backgroundAgentStartEvent", () => {
  it("builds background agent start event", () => {
    const result = backgroundAgentStartEvent("research", "find papers about transformers");
    expect(result).toContain('type="background-agent-start"');
    expect(result).toContain('session="background"');
    expect(result).toContain("<text>find papers about transformers</text>");
  });
});

describe("backgroundAgentResultEvent", () => {
  it("builds background agent result (text only)", () => {
    const result = backgroundAgentResultEvent(
      "bg-research",
      "research",
      { text: "found 3 papers" },
      "Forward to user.",
    );
    expect(result).toContain('type="background-agent-result"');
    expect(result).toContain('<original-event name="research" />');
    expect(result).toContain("<result>");
    expect(result).toContain("<text>found 3 papers</text>");
    expect(result).toContain("</result>");
    expect(result).not.toContain("<files>");
  });

  it("builds background agent result with files", () => {
    const result = backgroundAgentResultEvent(
      "bg-research",
      "research",
      { text: "here are the screenshots", files: ["/tmp/screenshot.png"] },
      "Forward to user.",
    );
    expect(result).toContain("<result>");
    expect(result).toContain("<text>here are the screenshots</text>");
    expect(result).toContain('<file path="/tmp/screenshot.png" />');
    expect(result).toContain("</result>");
  });

  it("includes instructions after result", () => {
    const result = backgroundAgentResultEvent(
      "bg-research",
      "research",
      { text: "done" },
      "Forward to user.",
    );
    expect(result).toContain("<instructions>Forward to user.</instructions>");
    const instrIdx = result.indexOf("<instructions>");
    const closeIdx = result.indexOf("</event>");
    expect(instrIdx).toBeLessThan(closeIdx);
    expect(instrIdx).toBeGreaterThan(result.indexOf("</result>"));
  });
});

describe("backgroundAgentProgressEvent", () => {
  it("builds progress event with progress tag", () => {
    const result = backgroundAgentProgressEvent(
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

describe("peekEvent", () => {
  it("builds peek event with instructions", () => {
    const result = peekEvent("peek-deploy", "deploy", "Brief status update.");
    expect(result).toContain('type="peek"');
    expect(result).toContain('<target-event name="deploy" />');
    expect(result).toContain("<instructions>Brief status update.</instructions>");
    expect(result).not.toContain("<text>");
  });
});

describe("healthCheckEvent", () => {
  it("builds health check event with instructions", () => {
    const result = healthCheckEvent("health-check-deploy", "deploy", "Report status.");
    expect(result).toContain('type="health-check"');
    expect(result).toContain('<target-event name="deploy" />');
    expect(result).toContain("<instructions>Report status.</instructions>");
  });
});
