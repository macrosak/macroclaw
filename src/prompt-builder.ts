import { DateTime } from "luxon";

const SYSTEM_PROMPT_BASE = `\
AI assistant running in macroclaw, an autonomous agent platform. \
Persistent workspace at cwd with config, memory, skills. \
Refer to workspace CLAUDE.md for identity, personality, conventions.

Responses delivered as chat messages. Keep concise and direct.

Structured output: you have a StructuredOutput tool. When you are done processing, \
call StructuredOutput to deliver your final response. \
Required fields: action ("send"|"silent"), actionReason. Include message when action="send".

Formatting: message field sent to Telegram with HTML parse mode. \
Use raw <b>, <i>, <code>, <pre> tags. Escape &, <, > in text content as &amp;, &lt;, &gt;.

Architecture: message bridge connecting chat interface and scheduled tasks. \
Persistent session — conversation history carries across messages. Workspace persists across sessions.

Event format: every incoming message is wrapped in an <event> XML block. Attributes:
- time — local time when the event was created (ISO 8601, minute precision).
- name — short identifier for this event (e.g. "check-logs", "cron-daily").
- type — what triggered this event. One of:
  - user-message — direct user message. Content in <text>, optional <files>.
  - button-click — user tapped an inline button. Label in <button>.
  - schedule-trigger — automated scheduled task. Contains <schedule> with name and optional missed-by/scheduled-at attributes. Prefer action="silent" when nothing noteworthy.
  - background-agent-start — you are a background agent. Complete the task in <text> and return a result.
  - background-agent-result — a background agent has finished. Contains <original-event name="..." /> linking to the agent that produced it, and a <result> block with <text> and optional <files>. Always use action="send" — the user expects to see the outcome. Summarize, relay, or add additional context from the conversation as appropriate.
  - background-agent-progress — interim progress update from a still-running background agent. Contains <original-event name="..." /> and a <progress> element. This is NOT a final result. Do not report to the user unless it contains exceptionally important information (errors, blockers, urgent findings). Keep this context in mind — if the user later asks about progress of a background task, use the latest progress update to answer.
  - peek — status check on a running session. Contains <target-event name="..." /> identifying the event being peeked at. Only consider progress since that event started. Respond with a brief status update (2-3 sentences): what has been done, what's happening now, what's remaining. Return plain text, not structured output.
  - health-check — automated status check on a background agent. Contains <target-event name="..." />. Report whether the task is complete or still in progress.
- session — "main" (primary conversation) or "background" (background agent).

Backgrounded events: when a new message arrives while a previous task is still running, \
the running task is automatically moved to a background session. The new event will contain \
a <backgrounded-event name="..." /> element referencing the task that was moved. \
This is informational — the backgrounded task continues running independently. \
Do not re-execute or act on the backgrounded task; focus on the new event's content.

Inner elements:
- <text> — the message text or task description.
- <files> — list of <file path="..." /> attachments. Read/view at those paths.
- <button> — the label of the tapped button.
- <schedule> — cron job metadata (name, missed-by, scheduled-at attributes).
- <backgrounded-event name="..." /> — a previously running task moved to background (see above).
- <original-event name="..." /> — in background-agent-result, links to the agent that produced the result.
- <target-event name="..." /> — in peek, identifies the event being checked on.
- <progress> — interim status from a still-running background agent.
- <result> — wraps the output from a completed background agent. Contains <text> and optional <files>.
- <instructions> — inline guidance for how to handle this specific event. Always follow these instructions.

Background agents: spawn alongside any response via backgroundAgents array:
  backgroundAgents: [{ name: "label", prompt: "task", model: "haiku" }]
Each runs in same workspace, forked session. Result fed back as background-agent-result event.
Models: haiku (fast/cheap), sonnet (balanced, default), opus (complex reasoning).
User can spawn directly with /bg command. Use for long-running tasks that shouldn't block.

Session routing: if a new message arrives while your session is busy for over 1 minute, \
the running task is automatically moved to background and a new session is forked. \
The new event will contain a <backgrounded-event> element (see above).

Files: send files via files array (absolute paths). \
Images (.png/.jpg/.jpeg/.gif/.webp) as photos, rest as documents. 50MB limit.

Cron: jobs in data/schedule.json (hot-reloaded). Cron jobs always run as background sessions. \
Use "silent" when check finds nothing new, "send" when noteworthy.

MessageButtons: include a buttons field (flat array of label strings) to attach inline buttons below your message. \
Each button gets its own row. Max 27 characters per label — if options need more detail, describe them in the message and use short labels on buttons.`;

interface BuildXmlFields {
  text?: string;
  files?: string[];
  button?: string;
  schedule?: { name: string; missedBy?: string; scheduledAt?: string };
  backgroundedEvent?: string;
  originalEvent?: string;
  targetEvent?: string;
  instructions?: string;
  progress?: string;
  result?: { text: string; files?: string[] };
}

export class PromptBuilder {
  readonly #timeZone: string;

  constructor(timeZone: string) {
    this.#timeZone = timeZone;
  }

  get systemPrompt(): string {
    return `${SYSTEM_PROMPT_BASE}\n\nTimezone: ${this.#timeZone}. TZ env var is set — \`date\` and other CLI tools return local time.`;
  }

  #localTime(): string {
    return DateTime.now().setZone(this.#timeZone).toFormat("yyyy-MM-dd'T'HH:mm");
  }

  static #escapeXml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  static #buildXml(name: string, type: string, session: string, time: string, fields: BuildXmlFields): string {
    const esc = PromptBuilder.#escapeXml;
    const lines: string[] = [
      `<event time="${time}" name="${esc(name)}" type="${type}" session="${session}">`,
    ];

    if (fields.backgroundedEvent) {
      lines.push(`<backgrounded-event name="${esc(fields.backgroundedEvent)}" />`);
    }

    if (fields.schedule) {
      const attrs = [`name="${esc(fields.schedule.name)}"`];
      if (fields.schedule.missedBy) attrs.push(`missed-by="${esc(fields.schedule.missedBy)}"`);
      if (fields.schedule.scheduledAt) attrs.push(`scheduled-at="${esc(fields.schedule.scheduledAt)}"`);
      lines.push(`<schedule ${attrs.join(" ")} />`);
    }

    if (fields.originalEvent) {
      lines.push(`<original-event name="${esc(fields.originalEvent)}" />`);
    }

    if (fields.targetEvent) {
      lines.push(`<target-event name="${esc(fields.targetEvent)}" />`);
    }

    if (fields.progress) {
      lines.push(`<progress>${esc(fields.progress)}</progress>`);
    }

    if (fields.result) {
      lines.push("<result>");
      lines.push(`<text>${esc(fields.result.text)}</text>`);
      if (fields.result.files?.length) {
        lines.push("<files>");
        for (const f of fields.result.files) {
          lines.push(`  <file path="${esc(f)}" />`);
        }
        lines.push("</files>");
      }
      lines.push("</result>");
    }

    if (fields.button) {
      lines.push(`<button>${esc(fields.button)}</button>`);
    }

    if (fields.text) {
      lines.push(`<text>${esc(fields.text)}</text>`);
    }

    if (fields.files?.length) {
      lines.push("<files>");
      for (const f of fields.files) {
        lines.push(`  <file path="${esc(f)}" />`);
      }
      lines.push("</files>");
    }

    if (fields.instructions) {
      lines.push(`<instructions>${esc(fields.instructions)}</instructions>`);
    }

    lines.push("</event>");
    return lines.join("\n");
  }

  userMessage(name: string, text: string, opts?: { files?: string[]; backgroundedEvent?: string }): string {
    return PromptBuilder.#buildXml(name, "user-message", "main", this.#localTime(), { text, files: opts?.files, backgroundedEvent: opts?.backgroundedEvent });
  }

  buttonClick(name: string, button: string, opts?: { backgroundedEvent?: string }): string {
    return PromptBuilder.#buildXml(name, "button-click", "main", this.#localTime(), { button, backgroundedEvent: opts?.backgroundedEvent });
  }

  scheduleTrigger(name: string, schedule: { name: string; missedBy?: string; scheduledAt?: string }, text: string): string {
    return PromptBuilder.#buildXml(name, "schedule-trigger", "background", this.#localTime(), { schedule, text });
  }

  backgroundAgentStart(name: string, text: string): string {
    return PromptBuilder.#buildXml(name, "background-agent-start", "background", this.#localTime(), { text });
  }

  backgroundAgentResult(name: string, originalEvent: string, result: { text: string; files?: string[] }, instructions: string, opts?: { backgroundedEvent?: string }): string {
    return PromptBuilder.#buildXml(name, "background-agent-result", "main", this.#localTime(), { originalEvent, result, instructions, backgroundedEvent: opts?.backgroundedEvent });
  }

  backgroundAgentProgress(name: string, originalEvent: string, progress: string, instructions: string, opts?: { backgroundedEvent?: string }): string {
    return PromptBuilder.#buildXml(name, "background-agent-progress", "main", this.#localTime(), { originalEvent, progress, instructions, backgroundedEvent: opts?.backgroundedEvent });
  }

  peek(name: string, targetEvent: string, instructions: string): string {
    return PromptBuilder.#buildXml(name, "peek", "background", this.#localTime(), { targetEvent, instructions });
  }

  healthCheck(name: string, targetEvent: string, instructions: string): string {
    return PromptBuilder.#buildXml(name, "health-check", "background", this.#localTime(), { targetEvent, instructions });
  }
}
