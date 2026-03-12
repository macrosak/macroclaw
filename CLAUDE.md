# Macroclaw

Telegram-to-Claude-Code bridge. Bun + Grammy.

## Design Principle

**Workspace-first.** Anything achievable within the workspace (new skills, instructions in workspace CLAUDE.md, cron jobs, memory files, etc.) should be done there. This project should only contain features that are not achievable from within the workspace — the bridge runtime, Telegram integration, cron scheduler, and Claude Code orchestration.

## Commands

```bash
bun install        # Install dependencies
bun run dev        # Start with watch mode
bun run start      # Start normally
bun run check      # Typecheck + lint + tests (run before committing)
bun test           # Run tests (100% coverage enforced)
bun run lint       # Run biome linter
bun run lint:fix   # Auto-fix lint issues
```

## Debugging

- To run `claude` CLI from Bash tool: `CLAUDECODE="" claude -p ...` (must explicitly set to empty to allow nested sessions)

## Logging

Use pino via `createLogger` from `src/logger.ts`. Never use `console.log/warn/error`.

- **error** — unexpected failures, caught exceptions that affect functionality
- **warn** — recoverable issues: validation failures, missing optional config, fallback behavior
- **info** — significant lifecycle events: startup, shutdown, connection established, session created
- **debug** — per-message flow: incoming messages, responses, Claude I/O, background task lifecycle

Every module should create its logger at the top: `const log = createLogger("module-name")`.
Log messages should be concise. Include relevant IDs/context as structured data, not string interpolation.

## Architecture

Two layers with unidirectional dependency: App → Orchestrator. App knows nothing about Claude, sessions, or queuing. Orchestrator knows nothing about Telegram.

```
App (app.ts)                        — I/O layer: Telegram + Cron
├── CronScheduler (cron.ts)         — reads .macroclaw/cron.json, fires onJob callback
└── Orchestrator (orchestrator.ts)  — processing layer: Claude, queue, sessions, background
    ├── Queue (queue.ts)            — serial FIFO processing (internal)
    └── Claude (claude.ts)          — spawns `claude` CLI, handles timeouts/deferred results
```

### App (I/O Layer)

- Receives Telegram messages, commands, buttons, file uploads
- Routes to `orchestrator.handleMessage/handleButton/handleCron/handleBackgroundCommand/handleBackgroundList/handleSessionCommand`
- Delivers `OrchestratorResponse` to Telegram via `onResponse` callback (files, text, buttons)
- Owns CronScheduler, wires its `onJob` to `orchestrator.handleCron`
- Only module that imports Grammy/Telegram

### Orchestrator (Processing Layer)

- Owns the internal queue — all `handleX` methods push to it, callers don't know it exists
- Tracks background agents internally (spawn, adopt, list)
- Manages sessions (resume, fork, recovery, persistence)
- Handles deferred/timeout responses — sends "taking longer" notification, adopts the completion
- Validates Claude's structured output against the response schema
- Notifies App of all responses via `onResponse` callback; silent responses are filtered internally

### Supporting Modules

- `createBot` (telegram.ts) and `createLogger` (logger.ts) — plain functions, thin wrappers with no state
- All classes use runtime private fields (`#`) for encapsulation
- `Claude` holds stable config (workspace, jsonSchema); per-request params go on `run()`

## Conventions

- Keep everything lean — this is a personal project
- No database, no containers, no agent SDK
- Single authorized chat only
- Messages are processed serially (FIFO queue)
- When adding a new environment variable, document it in `.env.example` with a one-line comment
- Use camelCase for acronyms in identifiers: `runCli`, `parseUrl`, `httpApi` (not `runCLI`, `parseURL`, `httpAPI`)

## Design Docs

- Design docs live in `docs.local/` (gitignored)
- Once all commits in a design doc are done, move it to `docs.local/archive/` and do not modify it further
- When creating a GitHub issue from a design doc: H1 becomes the issue title, the rest of the doc becomes the issue body (so someone else can implement it without extra context)

## Workflow

- Work autonomously — never ask "shall I commit?" — just commit and push
- Finish tasks completely before asking follow-up questions
- Follow-up fixes can happen after the main implementation
- Always run `bun run check` before committing (typecheck + lint + tests)
- **PRs by default.** Before implementing anything, ensure `main` is clean and up to date with `origin/main`, then create a feature branch off it. Open a PR when the work is ready.
