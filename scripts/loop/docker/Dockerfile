# Image for the phase 1 loop: Node 22, git, pnpm, Claude Code. Any image of yours with the same
# tools works too (see scripts/loop/README.md, "Con una tua immagine").
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Pin a version with CLAUDE_CODE_VERSION=2.1.300 (build arg) to compare runs over time.
ARG CLAUDE_CODE_VERSION=latest
RUN corepack enable && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
# The working volume starts as a copy of /work: owned by the user the loop runs as.
RUN mkdir -p /work /reports && chown node:node /work /reports
USER node
ENV DISABLE_AUTOUPDATER=1
WORKDIR /work
