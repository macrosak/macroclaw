---
name: schedule
description: >
  Schedule events, reminders, and recurring tasks. Use when the user wants to:
  set a reminder, schedule something for later, create a recurring task,
  set up a periodic check, automate a prompt on a schedule, or plan a
  one-time or repeating event at a specific time.
---

Schedule a new event by adding it to `.macroclaw/schedule.json`.

## When to use this

- **Reminders**: "remind me to call the dentist tomorrow at 10"
- **One-time events**: "send the weekly report this Friday at 5pm"
- **Recurring tasks**: "check my email every 30 minutes"
- **Periodic prompts**: "give me a morning summary every weekday at 9"
- **Scheduled checks**: "monitor the deploy status every 5 minutes for the next hour"
- **Future actions**: "next Monday, ask me how the presentation went"

## How to schedule

1. Read `.macroclaw/schedule.json` (create with `{"jobs": []}` if missing)
2. Convert the user's request to a cron expression (see reference below)
3. **Be proactive about timing**: if the user says "next week" or "tomorrow" without a specific time, pick the best time based on what you know (their routine, calendar, context) and confirm: "I'll remind you Wednesday at 9:00. Works for you?"
4. Append the new job to the `jobs` array
5. Write the updated file
6. Confirm: what was scheduled, when it will fire, and offer to adjust

## Natural language → cron

Convert user intent to cron expressions. The user's timezone is in their profile (CLAUDE.md/USER.md) — convert to UTC for cron.

Examples:
- "in 5 minutes" → compute the exact minute/hour, use a one-shot with `recurring: false`
- "tomorrow at 10am" → `0 8 14 3 *` (if user is UTC+2, March 13), `recurring: false`
- "every morning" → `0 7 * * *` (adjust for timezone)
- "every weekday at 9" → `0 7 * * 1-5` (UTC)
- "next Monday" → specific date cron, `recurring: false`
- "every 30 minutes" → `*/30 * * * *`

## schedule.json format

```json
{
  "jobs": [
    {
      "name": "morning-summary",
      "cron": "0 7 * * 1-5",
      "prompt": "Give me a morning summary of my tasks"
    },
    {
      "name": "email-check",
      "cron": "*/30 * * * *",
      "prompt": "Check if any important emails arrived",
      "model": "haiku"
    },
    {
      "name": "dentist-reminder",
      "cron": "0 8 15 3 *",
      "prompt": "Reminder: call the dentist to reschedule your appointment",
      "recurring": false
    }
  ]
}
```

## Job fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Short kebab-case identifier (e.g. `dentist-reminder`). Appears in the `[Context: cron/<name>]` prefix when fired. |
| `cron` | yes | Standard cron expression (UTC). See reference below. |
| `prompt` | yes | The message sent to the agent when the event fires. Write it as a natural instruction. |
| `recurring` | no | Defaults to `true`. Set to `false` for one-time events — they're automatically removed after firing. |
| `model` | no | Override the model. Use `haiku` for cheap checks, `opus` for complex reasoning. Omit for default. |

## Cron expression reference (UTC)

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
- `0 9 * * *` — daily at 9:00 UTC
- `0 7 * * 1-5` — weekdays at 7:00 UTC
- `*/30 * * * *` — every 30 minutes
- `0 */2 * * *` — every 2 hours
- `0 9,18 * * *` — at 9:00 and 18:00 UTC

## Notes

- Changes are hot-reloaded — no restart needed
- File location: `<workspace>/.macroclaw/schedule.json`
- One-shot events (`recurring: false`) are cleaned up automatically after firing
- Missed one-shot events (e.g. service was down) are fired with a `[missed event]` prefix when the service restarts
