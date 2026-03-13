# Macroclaw

Personal AI assistant, powered by Claude Code, delivered through Telegram.

A lightweight bridge that turns a Telegram chat into a personal AI assistant — one that remembers context across conversations, runs background tasks, handles files and voice messages, and can also write and debug code. Built on the Claude Code CLI (`claude -p`) to stay **compliant with Anthropic's ToS**. The platform handles Telegram I/O, process orchestration, and scheduling; everything else — personality, skills, memory, behavior — lives in a customizable workspace.

## Security Model

Macroclaw runs with `dangerouslySkipPermissions` enabled. This is intentional — the bot
is designed to run in an isolated environment (container or VM) where the workspace is
the entire world. The single authorized chat ID ensures only one user can interact with
the bot. See [Docker](#docker) for the recommended containerized setup.

## Requirements

- [Bun](https://bun.sh/) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in

## Quick Start

```bash
bunx macroclaw setup
```

This runs the setup wizard, which:
1. Asks for your **Telegram bot token** (from [@BotFather](https://t.me/BotFather))
2. Starts the bot temporarily so you can send `/chatid` to discover your chat ID
3. Asks for your **chat ID**, **model** preference, **workspace path**, and optional **OpenAI API key**
4. Saves settings to `~/.macroclaw/settings.json`
5. Offers to install as a system service — this installs macroclaw globally (`bun install -g`), registers it as a **launchd** agent (macOS) or **systemd** unit (Linux), and starts the bridge automatically

No separate install step needed — answering yes to the service prompt handles everything.

On subsequent runs, settings are pre-filled from the file.

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

**`openaiApiKey`** is used for voice message transcription via [OpenAI Whisper](https://platform.openai.com/docs/guides/speech-to-text). Without it, voice messages are ignored.

Env vars take precedence over settings file values. On startup, a masked settings summary is printed showing which values were overridden by env vars.

Session state (Claude session IDs) is stored separately in `~/.macroclaw/sessions.json`.

## Commands

Run `macroclaw --help` or `macroclaw <command> --help` for the complete reference.

| Command | Description |
|---------|-------------|
| `macroclaw start` | Start the bridge |
| `macroclaw setup` | Run the interactive setup wizard |
| `macroclaw claude` | Open Claude Code CLI in the main session |
| `macroclaw service install` | Install globally and register as a system service |
| `macroclaw service uninstall` | Stop and remove the system service |
| `macroclaw service start` | Start the system service |
| `macroclaw service stop` | Stop the system service |
| `macroclaw service update` | Reinstall latest version and restart |

### Running as a service

The recommended path is `bunx macroclaw setup` and answering yes to the service prompt (see [Quick Start](#quick-start)).

If macroclaw is already installed and configured, you can also install the service directly:

```bash
macroclaw service install
```

Both paths install macroclaw globally via `bun install -g`, register it as a **launchd** agent (macOS) or **systemd** unit (Linux) with auto-restart, and start the bridge.

On Linux, the command runs as a normal user. Only the privileged operations (writing to `/etc/systemd/system/`, systemctl commands) are elevated via `sudo`, which prompts for a password when needed. Package installation and path resolution stay in the user's environment.

## Docker

Run macroclaw in a Docker container. The workspace is bind-mounted from the host; everything else (settings, Claude auth, sessions) lives in a named Docker volume.

```bash
# 1. Login to Claude Code (one-time, interactive — use /login inside the session)
docker compose run --rm -w /workspace --entrypoint claude macroclaw

# 2. Setup macroclaw (one-time, interactive — bot token, chat ID, model)
docker compose run --rm macroclaw setup --skip-service

# 3. Start the bridge
docker compose up -d
```

The `WORKSPACE` env var is pre-set in `docker-compose.yml` so you don't need to configure the workspace path during setup. The `--skip-service` flag skips the service installation prompt (not applicable in Docker).

To build a specific version:

```bash
docker compose build --build-arg VERSION=0.18.0
```

To reset everything (remove containers, volumes, and images):

```bash
docker compose down -v --rmi all
```

### Development with Docker

Use `Dockerfile.dev` to build from local source instead of the published npm package:

```bash
docker compose -f docker-compose.dev.yml up -d
```

## Development

```bash
git clone git@github.com:macrosak/macroclaw.git
cd macroclaw
cp .env.example .env  # fill in real values (see .env.example for available vars)
bun install --frozen-lockfile

bun run dev    # start with watch mode
bun test       # run tests (100% coverage enforced)
bun run claude # open Claude Code CLI in current main session
```

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
- [`data/schedule.json`](workspace-template/data/schedule.json) — scheduled event definitions
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

## License

MIT
