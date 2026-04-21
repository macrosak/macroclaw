---
name: schedule-event
description: "Schedule events, reminders, and recurring tasks. Use when the user wants to: set a reminder, schedule something for later, create a recurring task, set up a periodic check, automate a prompt on a schedule, or plan a one-time or repeating event at a specific time."
---

Schedule a new event by adding it to `data/schedule.json`.

## When to use this

- **Reminders**: "remind me to call the dentist tomorrow at 10"
- **One-time events**: "send the weekly report this Friday at 5pm"
- **Recurring tasks**: "check my email every 30 minutes"
- **Periodic prompts**: "give me a morning summary every weekday at 9"
- **Scheduled checks**: "monitor the deploy status every 5 minutes for the next hour"
- **Future actions**: "next Monday, ask me how the presentation went"

## How to schedule

1. Run `date` to get the current date and time
2. Read `data/schedule.json` (create with `{"jobs": []}` if missing)
3. Determine job type:
   - **Recurring** → convert to a cron expression in local time. See reference below.
   - **One-time** → compute an ISO 8601 timestamp with the user's timezone offset for `fireAt`
4. **Route the job to a chat via the `chat` field** — see [Chat routing](#chat-routing) below. When scheduling from a conversation, target the chat the user is talking to you in (read the `<event chat="...">` attribute on the incoming event).
5. **Be proactive about timing**: if the user says "next week" or "tomorrow" without a specific time, pick the best time based on what you know (their routine, calendar, context)
6. Append the new job to the `jobs` array
7. Write the updated file
8. Confirm: what was scheduled, when it will fire, and offer to adjust

## Chat routing

Every incoming `<event>` has a `chat="<name>"` attribute identifying which chat it came from (e.g. `admin`, `family`). When a scheduled job fires, the bridge delivers the response to the chat named in the job's `chat` field.

- **Default (no `chat` field)** — response goes to the admin chat.
- **Explicit chat name** — e.g. `"chat": "family"`. Response goes to that chat.
- **Broadcast** — `"chat": "*"`. The same prompt runs once per authorized chat, and each response is delivered to that chat. Use sparingly — only for genuinely universal reminders.

When the user asks you to schedule something, set `chat` to the chat name from the incoming event's `chat` attribute so the reminder comes back to the same chat. Don't omit `chat` unless you know the job should reach the admin chat specifically.

## Natural language → job format

The user's timezone is in their profile (CLAUDE.md/USER.md).

**One-time events** use `fireAt` in local time (no offset needed — interpreted in the configured timezone):
- "in 5 minutes" → compute exact time, e.g. `"fireAt": "2026-03-16T10:05:00"`
- "tomorrow at 10am" → `"fireAt": "2026-03-14T10:00:00"`
- "next Monday" → `"fireAt": "2026-03-17T09:00:00"` (pick a sensible time)

Only add a timezone offset when the event targets a different timezone than the configured one (e.g. the user is traveling or scheduling for another location).

**Recurring events** use `cron` in local time:
- "every morning" → `"cron": "0 7 * * *"`
- "every weekday at 9" → `"cron": "0 9 * * 1-5"`
- "every 30 minutes" → `"cron": "*/30 * * * *"`

## schedule.json format

Two job types, discriminated by field:

```json
{
  "jobs": [
    {
      "name": "morning-summary",
      "cron": "0 7 * * 1-5",
      "prompt": "Give me a morning summary of my tasks",
      "chat": "admin"
    },
    {
      "name": "family-dinner-poll",
      "cron": "0 17 * * 5",
      "prompt": "Ask what everyone wants for dinner",
      "chat": "family"
    },
    {
      "name": "email-check",
      "cron": "*/30 * * * *",
      "prompt": "Check if any important emails arrived",
      "model": "haiku",
      "chat": "admin"
    },
    {
      "name": "dentist-reminder",
      "fireAt": "2026-03-15T08:00:00",
      "prompt": "Reminder: call the dentist to reschedule your appointment",
      "chat": "admin"
    }
  ]
}
```

## Job fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Short kebab-case identifier (e.g. `dentist-reminder`). Appears in the `<schedule name="...">` element and event name when fired. |
| `cron` | for recurring | Standard cron expression (local time). See reference below. |
| `fireAt` | for one-time | ISO 8601 timestamp (e.g. `2026-03-15T08:00:00`). Can include a timezone offset (e.g. `2026-03-15T08:00:00+01:00`); without one, the time is interpreted in the configured timezone. |
| `prompt` | yes | The message sent to the agent when the event fires. Write it as a natural instruction. |
| `chat` | no | Name of the chat to deliver the response to (e.g. `admin`, `family`). Defaults to `admin`. Use `"*"` to broadcast the prompt to every authorized chat. Match the `chat` attribute from the incoming `<event>` when scheduling from a conversation. |
| `model` | no | Override the model. Use `haiku` for cheap checks, `opus` for complex reasoning. Omit for default. |

Each job must have exactly one of `cron` or `fireAt` (not both).

## Cron expression reference (local time)

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

Common patterns:
- `0 9 * * *` — daily at 9:00
- `0 7 * * 1-5` — weekdays at 7:00
- `*/30 * * * *` — every 30 minutes
- `0 */2 * * *` — every 2 hours
- `0 9,18 * * *` — at 9:00 and 18:00

## Notes

- Changes are hot-reloaded — no restart needed
- File location: `<workspace>/data/schedule.json`
- One-shot events (`fireAt`) are cleaned up automatically after firing
- Missed one-shot events (e.g. service was down) are fired when the service restarts (up to 7 days late) with `missed-by` and `scheduled-at` attributes on the `<schedule>` element
