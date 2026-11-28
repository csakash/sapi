# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

**AI changes** lists anything that adds a provider or model, or widens what sapi or its child
processes can reach (hosts, files, tools). ARI-42 GOV-3 asks for this even though sapi has no
customers.

## [Unreleased]

### Added
- Phase 0 foundations: repository skeleton, community files, CI with pinned actions, ARI-42 record,
  Claude CLI probe scripts and sanitized stream fixtures.
- Phase 1 secure core: `sapi start`, `sapi login claude`, `sapi status`, `sapi clients`,
  `sapi pause`/`resume`. `POST /v1/chat/completions` (streamed and not), `GET /v1/models`,
  `GET /healthz`. Host and Origin checks, body limits, security headers, scoped client keys stored
  as hashes, per-key rate limits, daily budgets, concurrency caps, fair scheduling, kill switches,
  and a hash-chained request and event log with no bodies.
- Phase 2 setup: `sapi setup` (guided, or `--yes` with a flag for every prompt and `--env-file`
  for a 0600 key file), `sapi doctor` (`--json`, `--offline`), `sapi connect`, `sapi service
  install|uninstall|status`, `sapi start`/`stop` for the background service (launchd agent on
  macOS, systemd user unit with lingering on Linux), `sapi uninstall [--purge]`.
  `scripts/install.sh` verifies the SHA-256 (and the cosign signature when present) and installs
  to `~/.local/bin` without root. `docs/vm-setup.md`.
- Security suite in `test/security/` and contract tests with openai-node, openai-python and
  LangChain. `scripts/e2e/real-claude.ts` runs the same SDKs against a real signed-in subscription.

### Removed
- GitHub Actions workflows (CI, CodeQL, gitleaks, dependency review, Scorecard, ARI-42 gate), at
  the owner's request. `bun run ci` runs the same checks locally: install with the lockfile,
  lint, types, tests with the sandbox suite required, a compiled binary, the ARI-42 scan and
  gate, gitleaks and the sign-off check.

### AI changes
- `sapi setup` can install the `claude` CLI (the tested version, 2.1.332) with Anthropic's official
  installer, after the user says yes. The installer runs outside sapi's sandbox, as installing it
  by hand would, with sapi's profile as its config folder.
- Provider `claude-sub`: the Claude subscription through the unmodified `claude` CLI (tested
  2.1.332), run with no tools and no MCP servers inside sandbox-exec (macOS) or bwrap / a systemd
  user service (Linux). Outbound hosts: `api.anthropic.com`, `platform.claude.com`, `claude.ai`,
  `claude.com`, through sapi's egress proxy only.
- On macOS with CLI sign-in, the Claude child can also write `~/Library/Keychains` (through one link
  in its otherwise empty per-request `HOME`): the CLI keeps its sign-in in the login keychain and
  saves refreshed tokens there.
- Default model aliases `haiku`, `sonnet`, `opus` → `claude-haiku-5-5`, `claude-sonnet-5-5`,
  `claude-opus-5-5`.
- Prompt template `transcript-v1` for multi-turn chats (single messages are passed unchanged).
