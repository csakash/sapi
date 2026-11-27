# Phase 0 findings

Date: 2026-11-27 · Machine: macOS 26.2 (arm64), Claude Code 2.1.332, Bun 1.3.14

This answers every "Phase 0 checks" note in the build plan. Each item says **verified** (tested
here), **documented** (from primary docs, not tested), **corrected** (the plan was wrong) or
**pending** (needs a Linux VM or the maintainer's own sign-in). Scripts used are in
`scripts/phase0/`; recorded stream fixtures are in `test/fixtures/claude-cli/`.

## Summary of plan changes

1. **ChatGPT on headless VMs: no device code.** Sign in with ChatGPT offers third-party tools no
   device-code flow. On a VM, sapi runs the browser sign-in through an SSH port forward, or the user
   signs in on a laptop and copies the credentials to the VM (OpenAI's own documented path).
2. **ChatGPT client registration is two-step.** `dynamic_agent_client` is used only for the first
   registration; sapi then stores the issued `oaiapp_…` client ID, a per-host `ext_agent_host_id`
   and an `agent_name_hint`.
3. **ChatGPT requests must stream** (`stream: true`), use `instructions` instead of system messages,
   and count as successful only after `response.completed`.
4. **ChatGPT Pro has no 5-hour window**; only Plus shares one across apps. Usage windows aren't
   reported by the API, so ChatGPT limits are estimated (and recalibrated on 429
   `subscription_sharing_usage_limit_exceeded`).
5. **Linux confinement: bubblewrap, not `systemd-run --scope`.** Transient scopes can't apply
   sandboxing options, and `IPAddressDeny=` is ignored in user units. The Linux launcher uses
   `bwrap --unshare-net` with sapi's proxy reached through a bind-mounted Unix socket (the approach
   Claude Code's sandbox runtime and Codex use). Fallback: a transient user service with
   `PrivateUsers=yes` and `PrivateNetwork=yes`.
6. **Claude limits can be reported, not just estimated.** The CLI emits a `rate_limit_event` with
   per-window utilization and reset time.
7. **CLI overhead must be measured from wall-clock time.** `duration_ms − duration_api_ms` is only
   ~20 ms; process start adds ~270 ms on top of `duration_ms`.
8. **Use `--system-prompt-file` and `--restricted`.** Both work with a subscription login and
   reduce what client text and local settings can influence.
9. **Compiled binaries must disable `.env` and `bunfig.toml` autoloading.** Bun compiles them on by
   default; a stray `.env` in the working directory could otherwise change sapi's behaviour.
10. **npm name `sapi` is taken.** The package is `sapi-gateway` (private); the binary is still
    `sapi`. A GitHub and trademark check is still to do before the repo goes public.

## Claude CLI

| Check | Result | Status |
|---|---|---|
| Flags exist on 2.1.332 | `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--system-prompt`, `--system-prompt-file`, `--tools ""`, `--strict-mcp-config`, `--mcp-config`, `--max-turns`, `--input-format stream-json`, `--no-session-persistence`, `--json-schema`, `--setting-sources`, `--restricted`, `--safe-mode` all present (`claude --help`) | verified |
| No tools, no MCP | init event reports `tools: []` and `mcp_servers: []` with `--tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'` | verified |
| `--json-schema` | adds the CLI's own output-only `StructuredOutput` tool even with `--tools ""`; result is the JSON object | verified; the adapter's init check allows exactly this one tool |
| `--restricted` | works with a subscription login; ignores user, project and local settings files | verified |
| `--system-prompt-file` | works; client system text never needs to go on the command line | verified |
| `--bare` | never reads OAuth or the Keychain; needs an API key | documented; not usable for subscriptions |
| Minimal environment | `PATH`, `HOME`, `USER`, `LANG` are enough. **Without `USER` the macOS CLI can't find its Keychain login** ("Not logged in") | verified |
| `CLAUDE_CONFIG_DIR` | an empty directory gives `loggedIn: false`: login, settings, plugins and transcripts move with it, and the Keychain entry is keyed per directory | verified + documented |
| Auth check | `claude auth status --json` exits 0 when signed in, 1 when not; fields include `loggedIn`, `authMethod`, `subscriptionType`, `loginExpiresAt`, plus `email` and `orgName`, which sapi must not log | verified |
| Headless login | the CLI prints a URL and accepts a pasted code ("Paste code here if prompted") | documented; **pending** a run on a VM |
| `setup-token` | one-year, inference-only token used via `CLAUDE_CODE_OAUTH_TOKEN`; needs a browser to create; not saved anywhere | documented; **pending** a test (there are public reports of 401 errors) |
| Pinning the version | `claude install <version>`, or the installer with `bash -s <version>`; `DISABLE_UPDATES=1` blocks every update path, `DISABLE_AUTOUPDATER=1` only automatic ones | documented |
| Session files | `--no-session-persistence` keeps transcripts off disk | verified (flag accepted; no files checked) |
| Spurious "Not logged in" | 1 of about 25 runs reported "Not logged in" while signed in | verified; the adapter retries once when `claude auth status` says signed in |

### Timings (10 runs, `haiku`, prompt "Reply with exactly: ok")

| Measure | p50 | p90 |
|---|---|---|
| Process start → first text delta | 1,290 ms | 1,758 ms |
| Process start → exit | 1,315 ms | 1,805 ms |
| `duration_ms − duration_api_ms` | 20 ms | 26 ms |

`duration_ms` was about 1,040 ms against a wall time of about 1,315 ms, so process start and exit
add roughly 270 ms. The dashboard's "CLI overhead" is defined as wall-clock time minus
`duration_api_ms`.

### Stream shape

Event types seen: `system/init`, `system/status`, `stream_event` (`message_start`,
`content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`,
`message_stop`), `assistant`, `rate_limit_event`, `result/success`.

The `result` event carries `duration_ms`, `duration_api_ms`, `ttft_ms`, `num_turns`, `is_error`,
`stop_reason`, `total_cost_usd`, `usage` (input, output, cache-creation and cache-read tokens,
`inference_geo`), `modelUsage` and `credential_expires_at`. The last must not be logged.

`rate_limit_event.rate_limit_info`:

```json
{ "status": "allowed", "resetsAt": 1800000000, "rateLimitType": "seven_day",
  "overageStatus": "rejected", "isUsingOverage": false,
  "unifiedWindows": { "seven_day": { "utilization": 0.42, "resetsAt": 1800000000, "status": "allowed" } } }
```

(Values are from a sanitized fixture.) Only the seven-day window appeared in these runs; whether a
five-hour entry appears when that window is active is still to be observed.

## Egress

Measured with `scripts/phase0/egress-proxy.ts` as `HTTPS_PROXY` for the CLI:

| Setting | Hosts contacted |
|---|---|
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | `api.anthropic.com` only |
| without it | `api.anthropic.com` plus a Datadog log-intake host (telemetry) |

- The CLI honours `HTTPS_PROXY` (verified) and documents `NO_PROXY`; SOCKS isn't supported.
- Allowlist for the Claude provider manifest: `api.anthropic.com`, plus `platform.claude.com` for
  token refresh and `claude.ai` and `claude.com` for sign-in (from the CLI's network docs; refresh
  wasn't triggered during the test).
- Enforce mode verified: the CLI works with the allowlist; `example.com`, `169.254.169.254` and a
  loopback port are refused.

## macOS confinement

`scripts/phase0/claude-child.sb` with `sandbox-exec`, through the proxy in enforce mode:

| Check | Result |
|---|---|
| Real `claude -p` call | works (2 of 2 runs) |
| Read `~/.ssh` | denied |
| Write outside the profile and work dir | denied |
| Direct HTTPS to the internet, or to the metadata IP | denied |
| Via proxy to a host not on the allowlist | refused by the proxy |
| Write to the work dir | allowed **only when the path is resolved** (`/private/var/...`, not `/var/...`); the launcher must `realpath` every path it passes to the profile |

`sandbox-exec` is deprecated and Apple says the profile language is not a supported API, but Codex
and Claude Code's own sandbox ship it today. `sapi doctor` must detect when it stops working.

## Linux confinement (research; VM test pending)

- **Corrected:** `systemd-run --user --scope` can't apply `ProtectSystem`, `ProtectHome` and similar
  options, which only work for services. `IPAddressDeny=` is skipped in user units ("not running as
  root").
- **New design:** `bwrap --unshare-net` (plus a read-only root, a tmpfs home and the profile
  bind-mounted), with the egress proxy reached through a Unix socket bind-mounted into the sandbox.
  A small bridge inside the sandbox turns `127.0.0.1:<port>` into that socket; the sapi binary itself
  can play the bridge, so socat isn't needed.
- **Ubuntu 24.04 caveat:** AppArmor restricts unprivileged user namespaces by default, which can stop
  bwrap. `sapi setup` must detect this and explain the fix, or fall back.
- **Fallback:** a transient user service (`systemd-run --user --pipe --wait`) with
  `PrivateUsers=yes`, `ProtectSystem=strict`, `ProtectHome=tmpfs` and `PrivateNetwork=yes`.
  Implicit `PrivateUsers` arrived in systemd 253; Debian 12 (252) needs it set explicitly.
- **Pending:** run `bash scripts/phase0/linux-check.sh` on the target VM and paste the output below.

### Linux VM results

_Not run yet._

## ChatGPT (Sign in with ChatGPT)

From OpenAI's developer docs (`developers.openai.com/siwc/…`); not exercised with an account yet.

| Item | Detail |
|---|---|
| Endpoints | authorize `https://auth.openai.com/api/accounts/authorize`, token `…/api/accounts/oauth/token`, PKCE S256, `resource=https://api.openai.com/v1`, no client secret |
| Client ID | `dynamic_agent_client` only for first registration; store the issued `oaiapp_…` ID |
| Required extras | persisted `ext_agent_host_id` (distinct per host) and `agent_name_hint` |
| Redirect | `http://127.0.0.1:<port>/…`, never `localhost`; the port may vary (1455 is an example) |
| Scopes | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; check the granted scopes, because the user can decline the last one |
| Token lifetimes | access 1 hour; refresh 30 days, rotated on every refresh; revoke via the discovery document's endpoint |
| Headless | **no device code for third-party tools**; sign in locally and copy credentials over SSH, letting the VM own later refreshes |
| API | `POST https://api.openai.com/v1/responses`, `store: false`, `stream: true`; omit `temperature`, `top_p`, `max_output_tokens`, `metadata`, `user` and others; no hosted tools; system role rejected (use `instructions`); no `previous_response_id` |
| Limits | no documented usage headers; 429 `subscription_sharing_usage_limit_exceeded`, 403 `…_user_not_eligible`, 503 `…_usage_unavailable`; Pro has no 5-hour limit |
| Eligibility | quickstart says Plus and Pro; another OpenAI page says Go, Plus, Pro and Business. Free for open-source tools; paid or hosted apps need OpenAI's interest form |

## Bun and builds

| Check | Result | Status |
|---|---|---|
| `bun build --compile` targets | linux-x64, linux-arm64, darwin-arm64 built from macOS (ELF and Mach-O; 64–95 MB) | verified (cross-compile); **pending** running the Linux binaries on Linux |
| `.env` / `bunfig.toml` autoload | on by default in compiled binaries; build scripts pass `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` | verified |
| Minimum release age | `[install] minimumReleaseAge` in seconds (Bun 1.3+), set to 7 days in `bunfig.toml` | documented + configured |
| Lockfile | text `bun.lock` with `sha512` integrity per package; `--frozen-lockfile` fails on mismatch and isn't automatic in CI | verified + documented |
| `bun:sqlite` in compiled binaries | supported | documented |
| Latest Bun | 1.4.5 (19 Nov 2026); the repo pins 1.3.14, the version installed here. Renovate will propose the upgrade | documented |

## ARI-42 gate

- Installed: skill under `.agents/skills/ari42` and `.claude/skills/ari42`, blocks in `AGENTS.md`
  and `CLAUDE.md`, a SessionStart reminder hook in `.claude/settings.json`, and
  `.github/workflows/ari42.yml` (report mode).
- `ari42_scan.py check`: no findings. `verify`: 34 of 42 in scope, 2 met (SDLC-5, SDLC-6),
  as expected in Phase 0.
- Scanner issues worth reporting upstream (warden/ari42-skill):
  1. `_cited_files` strips the leading dot from `.github/...` evidence paths (`lstrip("./")`), so a
     workflow file can never be cited as evidence.
  2. `check` reports the same line three times when one line matches several bypass patterns.
  3. `detect` walks git-ignored folders (here `board/`).

## Still open after Phase 0

- Run `scripts/phase0/linux-check.sh` on the target VM; run the Linux binaries there.
- Try the headless `claude` login and a `setup-token` token on the VM.
- Exercise Sign in with ChatGPT with a real account (desktop and SSH-forwarded).
- GitHub name and trademark check; fill in maintainer handles.
- Push to GitHub and confirm CI is green there (everything passes locally).
