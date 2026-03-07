# Macroclaw

Telegram-to-Claude-Code bridge. Bun + Grammy.

## Design Principle

**Workspace-first.** Anything achievable within the workspace (new skills, instructions in workspace CLAUDE.md, cron jobs, memory files, etc.) should be done there. This project should only contain features that are not achievable from within the workspace — the bridge runtime, Telegram integration, cron scheduler, and Claude Code orchestration.

## Commands

```bash
bun install        # Install dependencies
bun run dev        # Start with watch mode
bun run start      # Start normally
bun test           # Run tests (100% coverage enforced)
bun run sync-skills # Deploy system skills to workspace
```

## Skills

- **System skills** live in `skills/` in this repo — they document macroclaw features (e.g. cron management)
- Run `bun run sync-skills` after changing system skills to deploy them to the workspace
- **User skills** are created directly in the workspace's `.claude/skills/` — the sync script never touches them

## Debugging

- To run `claude` CLI from Bash tool: `CLAUDECODE="" claude -p ...` (must explicitly set to empty to allow nested sessions)

## Conventions

- Keep everything lean — this is a personal project
- No database, no containers, no agent SDK
- Single authorized chat only
- Messages are processed serially (FIFO queue)

## Workflow

- Work autonomously — never ask "shall I commit?" — just commit and push
- Finish tasks completely before asking follow-up questions
- Follow-up fixes can happen after the main implementation
- Always run tests before committing (`bun test` enforces 100% coverage)
