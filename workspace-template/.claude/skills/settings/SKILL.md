---
name: settings
description: "Read or change macroclaw settings (model, timezone). Use when the user asks about current settings, wants to switch the Claude model, change the timezone, or asks what model/timezone is configured."
---

Read or change macroclaw settings. Only `model` and `timezone` can be changed through this skill.

## Settings file

Location: `~/.macroclaw/settings.json`

## Reading settings

When the user asks about current settings ("what model am I on?", "what's the timezone?"):

1. Read `~/.macroclaw/settings.json`
2. Report the requested value

## Changing settings

Allowed changes:
- **model**: `haiku`, `sonnet`, or `opus`
- **timezone**: any valid IANA timezone (e.g. `Europe/Prague`, `America/New_York`, `UTC`)

All other settings (botToken, chatId, workspace, etc.) cannot be changed through this skill — tell the user to run `macroclaw setup` instead.

## Procedure for changing a setting

Changing a setting requires a service restart, which kills the current process. Everything must happen in a single response — the same pattern as self-update.

1. **Read current settings**: Read `~/.macroclaw/settings.json` and note the current value.

2. **Validate**: Check the new value is valid (see allowed values above). If invalid, tell the user and stop.

3. **Write**: Update the value in `~/.macroclaw/settings.json`, preserving all other fields. Write the file with `JSON.stringify(settings, null, 2)` formatting.

4. **Generate LOG_FILE_PATH**: Run `echo "/tmp/macroclaw-restart-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"` and use the output as `<LOG_FILE_PATH>` in the following steps.

5. **Schedule follow-up**: Using the `schedule` skill, create a one-shot event 1 minute from now:
   - Name: `settings-check`
   - Prompt: `Check macroclaw restart after settings change. Read ~/.macroclaw/settings.json and confirm <setting>=<new-value>. Read <LOG_FILE_PATH> — if it contains "restarted", the restart succeeded. If the file doesn't exist or is empty, schedule another check in 1 minute. Run macroclaw service status to verify the service is running. Report the result.`
   - Model: `haiku`
   - Recurring: `false`

6. **Run the restart**: Execute the restart script bundled with this skill:
   ```
   bash ${CLAUDE_SKILL_DIR}/scripts/restart.sh <LOG_FILE_PATH>
   ```

## Important

- The restart stops the service, which kills all processes including this Claude Code session.
- Do NOT use a background agent — it gets killed along with the main process.
- Always run step 6 LAST — everything after it may not execute.