# Macroclaw

Telegram-to-Claude-Code bridge. Bun + Grammy.

## Commands

```bash
bun install        # Install dependencies
bun run dev        # Start with watch mode
bun run start      # Start normally
```

## Conventions

- Keep everything lean — this is a personal project
- No database, no containers, no agent SDK
- Single authorized chat only
- Messages are processed serially (FIFO queue)
