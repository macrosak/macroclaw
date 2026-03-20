export const SYSTEM_PROMPT = `\
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

Message format: every message is wrapped in a <context> XML block containing structured metadata \
followed by the content. The block contains:
- <session type="main|background" /> — whether this is the main conversation or a background agent.
- <source type="..." /> — what triggered this message. Types:
  - user — direct user message.
  - cron — automated scheduled task. May include name, missed-by, and scheduled-at attributes. Prefer action="silent" when nothing noteworthy.
  - button — user tapped an inline keyboard button. The label attribute contains the button text.
  - background-agent — you are a background agent. Complete the task and return a result.
  - background-result — output from a background agent you spawned. Decide whether to relay or handle silently.
  - demoted-task — a previous long-running task was moved to background. The prompt attribute shows what it was working on.
- Content tag — one of:
  - <prompt> — user message or cron/button prompt.
  - <task> — background agent task description.
  - <result> — output from a completed background agent.
- <files> — optional list of <file path="..." /> attachments. Read/view at those paths.

Background agents: spawn alongside any response via backgroundAgents array:
  backgroundAgents: [{ name: "label", prompt: "task", model: "haiku" }]
Each runs in same workspace, forked session. Result fed back as background-result source type.
Models: haiku (fast/cheap), sonnet (balanced, default), opus (complex reasoning).
User can spawn directly with /bg command. Use for long-running tasks that shouldn't block.

Session routing: if a new message arrives while your session is busy for over 1 minute, \
the running task is automatically moved to background and a new session is forked.

Files: send files via files array (absolute paths). \
Images (.png/.jpg/.jpeg/.gif/.webp) as photos, rest as documents. 50MB limit.

Cron: jobs in data/schedule.json (hot-reloaded). Cron jobs always run as background sessions. \
Use "silent" when check finds nothing new, "send" when noteworthy.

MessageButtons: include a buttons field (flat array of label strings) to attach inline buttons below your message. \
Each button gets its own row. Max 27 characters per label — if options need more detail, describe them in the message and use short labels on buttons.`;

// --- Context prefix builder ---

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type SessionType = "main" | "background";

export type ContextSource =
  | { type: "user" }
  | { type: "cron"; name: string; missedBy?: string; scheduledAt?: string }
  | { type: "button"; label: string }
  | { type: "background-agent"; name: string }
  | { type: "background-result"; name: string }
  | { type: "demoted-task"; prompt: string };

export interface ContextInput {
  session: SessionType;
  source: ContextSource;
  content?: { tag: "prompt" | "task" | "result"; text: string };
  files?: string[];
}

export function buildContextPrefix(input: ContextInput): string {
  const lines: string[] = ["<context>"];

  // Session
  lines.push(`<session type="${input.session}" />`);

  // Source
  const src = input.source;
  switch (src.type) {
    case "user":
      lines.push('<source type="user" />');
      break;
    case "cron": {
      const attrs = [`type="cron"`, `name="${escapeXml(src.name)}"`];
      if (src.missedBy) attrs.push(`missed-by="${escapeXml(src.missedBy)}"`);
      if (src.scheduledAt) attrs.push(`scheduled-at="${escapeXml(src.scheduledAt)}"`);
      lines.push(`<source ${attrs.join(" ")} />`);
      break;
    }
    case "button":
      lines.push(`<source type="button" label="${escapeXml(src.label)}" />`);
      break;
    case "background-agent":
      lines.push(`<source type="background-agent" name="${escapeXml(src.name)}" />`);
      break;
    case "background-result":
      lines.push(`<source type="background-result" name="${escapeXml(src.name)}" />`);
      break;
    case "demoted-task":
      lines.push(`<source type="demoted-task" prompt="${escapeXml(src.prompt)}" />`);
      break;
  }

  // Files
  if (input.files?.length) {
    lines.push("<files>");
    for (const f of input.files) {
      lines.push(`  <file path="${escapeXml(f)}" />`);
    }
    lines.push("</files>");
  }

  // Content
  if (input.content) {
    const { tag, text } = input.content;
    lines.push(`<${tag}>${escapeXml(text)}</${tag}>`);
  }

  lines.push("</context>");
  return lines.join("\n");
}
