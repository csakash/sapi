# Provider: Claude subscription (`claude-sub`)

Code: `src/providers/claude-sub/` (adapter, manifest, argv and environment, stream parser).

sapi runs the unmodified `claude` CLI as you, for you only. Sign-in happens inside the CLI
(`sapi login claude` hands the terminal to `claude auth login`), in a profile that belongs to sapi
(`~/.local/share/sapi/claude-profile`, used as `CLAUDE_CONFIG_DIR`). sapi never reads that
profile's credentials. It only checks the exit code of `claude auth status`.

## Data flow (ARI-42 DATA-1)

| Step | What moves | Where it goes | Kept? |
|---|---|---|---|
| Client → sapi | messages, system prompt, model alias, parameters | sapi process memory | no bodies stored; one metadata row per request (`requests` table) |
| sapi → child stdin | the caller's text; one user message is passed byte for byte, a multi-turn chat is rendered with `src/prompts/transcript-v1.ts` | the `claude` child | no |
| sapi → child file | the caller's system prompt, in `system.txt` (0600) inside a per-request work dir | the `claude` child | deleted when the request ends; stale work dirs are removed at start-up |
| child → Anthropic | the prompt and system prompt | `api.anthropic.com` through sapi's egress proxy (allowlist: `api.anthropic.com`, `platform.claude.com`, `claude.ai`, `claude.com`) | Anthropic's terms for your plan; check the model-training setting in Claude's privacy settings |
| child → sapi | stream-json events: text, usage, cost, timings, usage windows | sapi, parsed with Zod | usage numbers and window readings only |
| sapi → client | text, usage, finish reason | the client | no |

What sapi adds to your data: nothing for a single message; for a multi-turn chat, the versioned
transcript wrapper and nothing else (tested in `test/security/env-scrub.test.ts`). The CLI's own
session files are off (`--no-session-persistence`).

## Command line

Built in `src/providers/claude-sub/spawn.ts` from constants and the configured model ID only:

```text
claude -p --output-format stream-json --verbose --include-partial-messages
  --model <pinned ID from config> --system-prompt-file <work dir>/system.txt
  --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --max-turns 1
  --no-session-persistence --restricted --safe-mode --disable-slash-commands
```

`--safe-mode` and `--disable-slash-commands` were added in Phase 1 on top of the plan's flags: they
turn off CLAUDE.md, skills, plugins, hooks and commands even if something lands in sapi's profile.
All flags were checked together against `claude` 2.1.332 with a signed-out profile.

## Environment

Built from scratch (`claudeChildEnv`): `PATH` (the CLI's directory, `/usr/bin`, `/bin`), `HOME`
(a fresh directory inside the work dir; see below), `USER`, `LOGNAME`, `LANG`, `TZ=UTC`, `CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_UPDATES=1`, `DISABLE_AUTOUPDATER=1`, the proxy
variables, and `CLAUDE_CODE_OAUTH_TOKEN` only when `[claude] auth = "env"`.

### HOME and the macOS keychain

On macOS the CLI keeps its sign-in in the login keychain, not in the profile, and the Security
framework finds that keychain through `HOME`. With an empty `HOME`, `claude auth status` reports
"not logged in" (checked on 2.1.332). So with `auth = "cli"` on macOS the per-request `HOME` holds
exactly one entry, a link `Library/Keychains` → `~/Library/Keychains`, and the sandbox lets the
child write that folder, because the CLI saves a refreshed sign-in there itself. sapi never reads
the keychain. On Linux, and with `auth = "env"`, `HOME` stays empty.

## Confinement

| OS | Launcher | Network | Files |
|---|---|---|---|
| macOS | `sandbox-exec` (profile in `src/sandbox/launchers.ts`) | only sapi's proxy on loopback | writes only to the profile, the work dir and (CLI sign-in) `~/Library/Keychains`; reads denied for secret and personal folders, `~/.claude`, and sapi's data and config |
| Linux | `bwrap --unshare-all` | none; the proxy is reached through a bind-mounted Unix socket and sapi's bridge | read-only root, tmpfs home and `/tmp`, profile and work dir bound read-write |
| Linux fallback | transient systemd user service | `PrivateNetwork=yes`, same bridge | `ProtectSystem=strict`, `ProtectHome=tmpfs` |

With `[claude] confinement = "required"` (the default), the provider reports "not ready" when no
launcher works, rather than running unconfined.

## Measured on a real subscription

2026-11-27, macOS 26.2, `claude` 2.1.332, `haiku` → `claude-haiku-5-5`, sandbox-exec:

- `scripts/e2e/real-claude.ts`: 8 of 8 checks pass (openai-node non-streamed, streamed,
  multi-turn, system prompt; openai-python 1.68.2 both ways; LangChain invoke and stream).
- About 0.8–1.5 s per short reply; sapi's own overhead (spawn, sandbox, proxy) about 200 ms after
  the first call, 700 ms on the first.
- The CLI's own preamble adds about 615 prompt tokens to every call, written to the prompt cache
  and not read back between calls.
- No `egress_blocked` events: with non-essential traffic off, the CLI only contacted allowlisted
  hosts. Both usage windows (`5h`, `weekly`) were read from `rate_limit_event`.
- `sapi pause --provider claude-sub` ended a live stream in 0.4 s; the child was gone and the next
  call got 503.
- No prompt text in `sapi.db` or its WAL; no work dirs left behind.

## Errors

| CLI signal | sapi error |
|---|---|
| `authentication_failed`, "Not logged in" | 503 `provider_not_ready` ("run sapi login claude"); retried once if `claude auth status` says signed in |
| `model_not_found`, API 404 | 502 `upstream_error` ("check [models] in config") |
| a rejected usage window, API 429 | 429 `provider_window_exhausted` with `Retry-After`; later calls fail fast until the reset |
| init event lists any tool or MCP server | 502 `upstream_error`; the child is killed and a `child_unsafe_init` event is logged |
