# Phase 1 notes: secure core with Claude

Date: 2026-11-27. Branch: `phase-1-secure-core`.

## Built

| Area | Files | Tests |
|---|---|---|
| HTTP surface: loopback-only bind, Host allowlist, Origin and Fetch-Metadata checks, JSON-only bodies with a size cap, security headers, no CORS, Bun's idle timeout for slow clients | `src/server.ts`, `src/http-guards.ts` | `test/security/http.test.ts`, `test/security/auth-everywhere.test.ts` |
| Client keys: 256-bit, shown once, SHA-256 + lookup prefix, constant-time check, scope (models, providers), expiry, disable, rotate | `src/auth.ts` | `test/security/http.test.ts`, `test/unit/cli.test.ts` |
| Rate limits, daily request and token budgets, per-key concurrency | `src/budgets.ts` | `test/security/http.test.ts`, `test/security/kill-switch.test.ts` |
| Kill switches (global, provider, client), stored in SQLite, polled every 500 ms so `sapi pause` stops running requests | `src/killswitch.ts`, `src/gateway.ts` | `test/security/kill-switch.test.ts` |
| Scheduler: per-provider slots (Claude: 3), fair round-robin across clients, queue cap and timeout | `src/scheduler.ts` | `test/unit/core.test.ts` |
| Meter: one hash-chained metadata row per request, events log, limit snapshots | `src/meter.ts`, `src/db.ts`, `src/hashchain.ts` | `test/unit/core.test.ts`, `test/security/kill-switch.test.ts` |
| OpenAI Chat Completions door (streamed and not), `/v1/models`, `/healthz` | `src/doors/chat.ts`, `src/gateway.ts` | `test/contract/sdks.test.ts` |
| Claude adapter: argv from config only, minimal env, per-request work dir, init safety check, Zod-parsed stream, limit windows, error mapping, one retry on a spurious "Not logged in" | `src/providers/claude-sub/` | `test/unit/claude-stream.test.ts`, `test/security/env-scrub.test.ts` |
| Launchers: sandbox-exec (macOS), bwrap with the Unix-socket bridge, systemd user-service fallback | `src/sandbox/` | `test/security/confinement.test.ts` |
| Egress proxy: CONNECT to allowlisted hostnames on 443, every DNS answer checked, connects to the checked address | `src/egress-proxy.ts`, `src/ssrf.ts` | `test/security/egress.test.ts` |
| CLI: `start`, `login claude`, `status`, `clients add/list/disable/enable/rotate`, `pause`, `resume` | `src/cli.ts`, `src/start.ts` | `test/unit/cli.test.ts` |
| Fake provider for tests and the future install e2e | `src/providers/fake/` | used throughout |

253 tests, 0 failures on macOS (one runs only in CI, one only on Linux). `ari42_scan.py check`: no
findings.

**Real Claude, end to end (macOS).** With sapi's profile signed in, `scripts/e2e/real-claude.ts`
passes 8 of 8: openai-node (non-streamed, streamed, multi-turn, system prompt), openai-python
1.68.2 (both ways) and LangChain (invoke and stream), all through sandbox-exec and the egress
proxy. A kill switch ended a live Claude stream in 0.4 s. Numbers are in
`docs/providers/claude-sub.md` ("Measured on a real subscription").

## Changes from the plan

- **No Hono.** `Bun.serve` with a small router covers four routes; one fewer runtime dependency.
  Zod (4.6.7) is the only runtime dependency.
- **Extra CLI flags:** `--safe-mode` and `--disable-slash-commands` on top of `--restricted`. All
  checked together on 2.1.332.
- **The child's HOME is a fresh directory per request**, not the real home. On macOS with CLI
  sign-in it holds one link, `Library/Keychains`, and the sandbox lets the child write that folder:
  the first real run showed the CLI can't find its sign-in otherwise, and it saves refreshed
  tokens there itself.
- **The profile isn't read-only to the child.** The CLI must write its own profile (token refresh,
  state). What is protected instead: the child can't read or write sapi's database and config, and
  the profile is separate from the user's own `~/.claude`.
- **`confinement = "required"` by default.** With no working launcher the Claude provider reports
  not ready instead of running unconfined; `"best-effort"` must be set explicitly.
- **Secret-store abstraction deferred to Phase 3.** Phase 1 holds no provider secret (client keys
  are hashes, the Claude login stays in the CLI, `claude.env` is the user's own 0600 file). The
  store lands with its first real user, the ChatGPT tokens.
- **Tools, JSON-schema output and images return a clear 400** until Phase 5 (imitated tools and
  schema validation).
- **Retention and purge** of old log rows are not built yet; they come with `sapi purge` and
  `sapi doctor`.
- **Memory limits:** only the systemd fallback sets `MemoryMax`. sandbox-exec and bwrap rely on
  sapi's own first-token and total timeouts.

## Bugs found by the tests

- The first real run reported "Claude isn't signed in" although `sapi status` said signed in: the
  login lives in the macOS keychain, which the Security framework finds through `HOME`, and the
  child's `HOME` was empty. Fixed with the keychain link above.
- A streamed response stalled when an event produced no output frame (usage, limit): Bun doesn't
  call `pull()` again after a pull that enqueued nothing. The stream now reads until it has a frame.
- Hash-chain rows written with only some columns didn't verify, because a later `SELECT *` reads
  the missing columns as NULL. The chain now hashes a fixed, schema-checked column list.

## Still open

- **A token refresh under the sandbox.** The keychain folder is writable for this, but no refresh
  happened during the run. Watch for a "not signed in" after the first few hours of use.
- **Linux.** bwrap and the systemd fallback have only been unit-checked. CI installs bubblewrap and
  fails if the confinement suite would skip; the VM run of `scripts/phase0/linux-check.sh` is still
  pending.
- **Python contract tests** run where `openai` and `langchain_openai` are installed (they ran here);
  CI doesn't install them yet.
