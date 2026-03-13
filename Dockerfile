FROM oven/bun:latest

ARG VERSION=latest

RUN apt-get update && apt-get install -y curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash macroclaw
USER macroclaw
WORKDIR /home/macroclaw

# Override oven/bun default which points to /usr/local/bin (root-owned)
ENV BUN_INSTALL_BIN="/home/macroclaw/.bun/bin"

# Install Claude Code CLI (standalone binary, installs to ~/.local/bin)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install macroclaw from npm
RUN bun install -g macroclaw@${VERSION}

ENV PATH="/home/macroclaw/.local/bin:${BUN_INSTALL_BIN}:$PATH"

ENTRYPOINT ["macroclaw"]
CMD ["start"]
