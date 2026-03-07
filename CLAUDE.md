# Macroclaw

Telegram-to-Claude-Code bridge. Bun + Grammy.

## Commands

```bash
bun install        # Install dependencies
bun run dev        # Start with watch mode
bun run start      # Start normally
```

## Skills

- **System skills** live in `skills/` in this repo — they document macroclaw features (e.g. cron management)
- Run `bun run sync-skills` after changing system skills to deploy them to the workspace
- **User skills** are created directly in the workspace's `.claude/skills/` — the sync script never touches them

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
