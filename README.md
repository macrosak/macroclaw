# Macroclaw

Telegram-to-Claude-Code bridge. Bun + Grammy.

Uses the Claude Code CLI (`claude -p`) rather than the Agent SDK to avoid any possible
ToS issues with using a Claude subscription programmatically.

## Vision

Macroclaw is a minimal bridge between Telegram and Claude Code. It handles the parts
that a Claude session can't: receiving messages, managing processes, scheduling tasks,
and delivering responses.

Everything else — personality, memory, skills, behavior, conventions — lives in the
workspace. The platform stays small so the workspace can be infinitely customizable
without touching platform code.

## Architecture

Macroclaw follows a **thin platform, rich workspace** design:

**Platform** (this repo) — the runtime bridge:
- Telegram bot connection and message routing
- Claude Code process orchestration and session management
- Background agent spawning and lifecycle
- Cron scheduler (reads job definitions from workspace)
- Message queue (FIFO, serial processing)
- Timeout management and auto-retry

**Workspace** — the intelligence layer, initialized from [`workspace-template/`](workspace-template/):
- [`CLAUDE.md`](workspace-template/CLAUDE.md) — agent behavior, conventions, response style
- [`.claude/skills/`](workspace-template/.claude/skills/) — teachable capabilities
- [`.macroclaw/cron.json`](workspace-template/.macroclaw/cron.json) — scheduled job definitions
- [`MEMORY.md`](workspace-template/MEMORY.md) — persistent memory

### Where does a new feature belong?

**Platform** when it:
- Requires external API access (Telegram, future integrations)
- Manages processes (spawning Claude, background agents, timeouts)
- Operates outside Claude sessions (cron scheduling, message queuing)
- Is a security boundary (chat authorization, workspace isolation)
- Is bootstrap logic (workspace initialization)

**Workspace** when it:
- Defines agent behavior or personality
- Is a convention Claude can follow via instructions
- Can be implemented as a skill
- Is data that Claude reads/writes (memory, tasks, cron definitions)
- Is a formatting or response style rule

> **Litmus test:** Could this feature work if you just wrote instructions in CLAUDE.md and/or created a skill? If yes → workspace. If no → platform.

## Security Model

Macroclaw runs with `dangerouslySkipPermissions` enabled. This is intentional — the bot
is designed to run in an isolated environment (container or VM) where the workspace is
the entire world. The single authorized chat ID ensures only one user can interact with
the bot.

## Requirements

- [Bun](https://bun.sh/) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in

## Setup

```bash
# Install globally
bun install -g macroclaw

# Run — on first launch, an interactive setup wizard guides you through configuration
macroclaw
```

The setup wizard will:
1. Ask for your **Telegram bot token** (from [@BotFather](https://t.me/BotFather))
2. Start the bot temporarily so you can send `/chatid` to discover your chat ID
3. Ask for your **chat ID**, **model** preference, **workspace path**, and optional **OpenAI API key**
4. Save settings to `~/.macroclaw/settings.json`

On subsequent runs, settings are loaded from the file. Environment variables override file settings (see `.env.example`).

### Configuration

Settings are stored in `~/.macroclaw/settings.json` and validated on startup.

| Setting        | Env var override       | Default                    | Required |
|----------------|------------------------|----------------------------|----------|
| `botToken`     | `TELEGRAM_BOT_TOKEN`   | —                          | Yes      |
| `chatId`       | `AUTHORIZED_CHAT_ID`   | —                          | Yes      |
| `model`        | `MODEL`                | `sonnet`                   | No       |
| `workspace`    | `WORKSPACE`            | `~/.macroclaw-workspace`   | No       |
| `openaiApiKey` | `OPENAI_API_KEY`       | —                          | No       |
| `logLevel`     | `LOG_LEVEL`            | `debug`                    | No       |
| `pinoramaUrl`  | `PINORAMA_URL`         | —                          | No       |

Env vars take precedence over settings file values. On startup, a masked settings summary is printed showing which values were overridden by env vars.

Session state (Claude session IDs) is stored separately in `~/.macroclaw/sessions.json`.

## Usage

Run inside a tmux session so it survives SSH disconnects:

```bash
tmux new -s macroclaw       # start session
macroclaw                   # run the bot

# Ctrl+B, D              — detach (bot keeps running)
# tmux attach -t macroclaw — reattach later
# tmux kill-session -t macroclaw — stop everything
```

## Development

```bash
git clone git@github.com:macrosak/macroclaw.git
cd macroclaw
cp .env.example .env  # fill in real values
bun install --frozen-lockfile
```

```bash
bun run dev    # start with watch mode
bun test       # run tests (100% coverage enforced)
bun run claude # open Claude Code CLI in current main session
```

## License

MIT
