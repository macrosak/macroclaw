---
name: add-cronjob
description: Add a new scheduled cron job. Use when the user wants to schedule a recurring prompt, add a periodic task, or set up automated messages.
---

Add a new cron job to `.macroclaw/cron.json` in this workspace.

## Steps

1. Read the current `.macroclaw/cron.json` file (create it if missing with `{"jobs": []}`)
2. Ask the user what prompt to run and when (if not already specified)
3. Build a standard cron expression for the schedule
4. Append the new job to the `jobs` array
5. Write the updated file
6. Confirm what was added and when it will next run

## cron.json format

```json
{
  "jobs": [
    {
      "name": "morning-summary",
      "cron": "0 9 * * *",
      "prompt": "Give me a morning summary of my tasks"
    },
    {
      "name": "email-check",
      "cron": "*/30 * * * *",
      "prompt": "Check if any important emails arrived",
      "model": "haiku"
    },
    {
      "name": "weekly-report",
      "cron": "0 17 * * 5",
      "prompt": "Generate a weekly report of completed tasks",
      "recurring": false
    }
  ]
}
```

## Job fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Short identifier for the job. Appears in the `[Tool: cron/<name>]` prefix so the agent knows which job triggered the prompt. Use kebab-case (e.g. `morning-summary`). |
| `cron` | yes | Standard cron expression defining when the job runs. See reference below. |
| `prompt` | yes | The message sent to Claude when the job fires. Write it as if you're typing a message in Telegram — the agent will receive and act on it. |
| `recurring` | no | Whether the job repeats. Defaults to `true`. Set to `false` for one-shot jobs that should fire once and be automatically removed from cron.json. Good for reminders ("remind me to call the dentist tomorrow at 10") or one-time scheduled events ("send the weekly report this Friday"). |
| `model` | no | Override the model for this specific job. Omit to use the default model (set via `MODEL` in `.env`), which is best for normal interactive tasks. Use `haiku` for cheap/fast routine checks (email polling, status pings). Use `opus` only when the task genuinely needs deeper reasoning. |

## Cron expression reference

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
- `0 9 * * 1-5` — weekdays at 9:00
- `*/30 * * * *` — every 30 minutes
- `0 */2 * * *` — every 2 hours
- `0 9,18 * * *` — at 9:00 and 18:00

## Notes

- Changes are hot-reloaded — no restart needed
- File location: `<workspace>/.macroclaw/cron.json`
- Prompts are injected into the conversation with a `[Tool: cron/<name>]` prefix
- One-shot jobs (`recurring: false`) are cleaned up automatically after firing
