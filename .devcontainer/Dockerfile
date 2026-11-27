# Development container for contributors and their coding agents (ARI-42 SDLC-2).
# No production credentials or provider logins belong in here.
# Base image pinned by digest (GW-2); Renovate keeps the digest current.
FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

# git for development, python3 for the ARI-42 scanner. No other tooling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

USER bun
WORKDIR /workspaces/sapi
