---
name: self-update
description: "Update macroclaw to the latest version. Use when the user asks to update, upgrade, self-update, or update yourself. Handles the service restart safely by using a detached process and scheduled follow-up."
---

Update macroclaw to the latest version.

## Steps

1. **Check service status**: Run `macroclaw service status` and verify it shows `Installed: yes` and `Running: yes`. If not, tell the user the service isn't running and stop.

2. **Generate LOG_FILE_PATH**: Run `echo "/tmp/macroclaw-update-$(date -u +%Y-%m-%dT%H-%M-%SZ).log"` and use the output as `<LOG_FILE_PATH>` in the following steps.

3. **Schedule follow-up**: Using the `schedule` skill, create a one-shot event 1 minute from now:
   - Name: `self-update-check`
   - Prompt: `Check macroclaw update result. Read <LOG_FILE_PATH> — if it contains "Updated macroclaw", report the version change. If it contains "already up to date", say so. If the file doesn't exist or is empty, the update may still be in progress — schedule another check in 1 minute.`
   - Model: `haiku`
   - Recurring: `false`

4. **Run the update**: Execute the update script bundled with this skill:
   ```
   bash ${CLAUDE_SKILL_DIR}/scripts/update.sh <LOG_FILE_PATH>
   ```

## Important

- The `macroclaw service update` command stops the service, installs the latest version, and starts it again. Stopping the service kills all processes in the cgroup — including this Claude Code session.
- Do NOT use a background agent — it gets killed along with the main process.
- Always run step 4 LAST — everything after it may not execute.
