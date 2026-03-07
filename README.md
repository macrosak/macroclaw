# Macroclaw

Telegram-to-Claude-Code bridge. Bun + Grammy.

## Setup

```bash
git clone git@github.com:macrosak/macroclaw.git
cd macroclaw
cp .env.example .env  # fill in real values
bun install --frozen-lockfile
```

## Usage

Run inside a tmux session so it survives SSH disconnects:

```bash
tmux new -s macroclaw       # start session
bun run start               # run the bot

# Ctrl+B, D              — detach (bot keeps running)
# tmux attach -t macroclaw — reattach later
# tmux kill-session -t macroclaw — stop everything
```

## Development

```bash
bun run dev    # start with watch mode
bun test       # run tests (100% coverage enforced)
```
