# ARI-42 record: sapi

Security record for the AI and agent parts of this project, kept by the coding agent under the
ARI-42 skill and reviewed by people. Update it in the same change as the code.

- **Last reviewed:** 2026-11-27 (Phase 2)
- **Owner for AI security:** _to be named by the maintainer (see GOVERNANCE.md)_
- **Score:** 14 of 34 in-scope requirements met with evidence · 0 Risk · 1 Gap · 15 Partial · 4 Human

Scope follows the project lens for what sapi is being built to be (an LLM gateway that embeds the
`claude` coding-agent CLI and exposes an agent HTTP endpoint), not only what the scanner finds. The
CI gate runs in report mode until the 0.1 release, then blocks.

Phase 1 verification ran on macOS 26.2 (sandbox-exec), including a real end-to-end run against a
signed-in Claude subscription (`scripts/e2e/real-claude.ts`: openai-node, openai-python and
LangChain, streamed and non-streamed, all passing; a kill switch stopped a live Claude stream in
0.4 s). The Linux launchers (bwrap and the systemd
user-service fallback) are written and unit-checked, and CI installs bubblewrap and refuses to skip
the confinement suite, but they have not run yet: that happens on the first CI run or on the VM.
Requirements that depend on them stay Partial until then.

## AI-BOM (GOV-1)

Checked by hand against `python3 .agents/skills/ari42/scripts/ari42_scan.py detect .`. Generation
from the provider manifests in CI is still to do.

| Component | Kind | Version / pin | Where | Data it can reach | Owner |
|---|---|---|---|---|---|
| Claude Code CLI (`claude`) | coding-agent harness, run as a confined child process | tested 2.1.332; `[claude] version_range = ">=2.1.332"` enforced before every run | `src/providers/claude-sub/` | the prompt sapi passes; its own login in sapi's profile | maintainer |
| claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5 (aliases `haiku`, `sonnet`, `opus`) | models | full IDs in `src/config.ts` defaults; "-latest" refused | `src/config.ts` | request content | maintainer |
| Built-in fake provider | deterministic test provider, no network | in-tree | `src/providers/fake/` | request content (in memory) | maintainer |
| `openai` (Node SDK) | vendor SDK, **dev dependency for contract tests only**; not in the shipped binary | 7.61.0, exact, integrity hash in `bun.lock` | `test/contract/sdks.test.ts` | the local test gateway | maintainer |
| `zod` | schema validation (not AI; listed because it validates model output) | 4.6.7, exact, no dependencies | `src/` | n/a | maintainer |
| ChatGPT subscription via Sign in with ChatGPT | provider (planned, Phase 3) | — | — | request content | maintainer |
| ARI-42 skill | engineering skill | warden/ari42-skill commit `6a4f8a48dfa4` (v1.1.0) | `.agents/skills/ari42/`, `.claude/skills/ari42/` | repository files | maintainer |
| Biome, TypeScript, @types/bun | development tools | exact versions with integrity hashes in `bun.lock` | `package.json` | none | maintainer |

## Agent register (GOV-4)

| Agent | Tools (read / write / consequential) | Autonomy | Approval required for | Accountable owner |
|---|---|---|---|---|
| Claude child process (`claude -p`) | none: `--tools ""`, empty strict MCP config, `--restricted`, `--safe-mode`, `--disable-slash-commands`. The adapter aborts the request if the init event lists any tool or MCP server (`src/providers/claude-sub/stream.ts`) | suggest only: returns text, never acts; one turn | nothing: sapi never executes tool calls | maintainer (to be named) |

## Trust boundaries (INJ-1, INJ-2)

| Agent | Untrusted inputs (who can write them) | Private data | Exfiltration paths | Control that breaks the trifecta |
|---|---|---|---|---|
| Claude child process | request content from any local client holding a sapi key | its own sign-in only (on macOS the login keychain, reached through one `Library/Keychains` link in its otherwise empty per-request `HOME`); an empty work dir, no secrets in its environment, sapi's data and config hidden by the sandbox | none by design: no tools; network only to the egress proxy, which allows only Anthropic hosts | no tools (enforced at init) + egress allowlist + OS sandbox (`test/security/confinement.test.ts`) |
| sapi gateway (not an agent; listed for completeness) | request bodies and headers (local clients; a web page if the Host and Origin checks failed), CLI stream output, config files | client key hashes, request metadata, kill-switch state | Anthropic hosts only, through the proxy | Host and Origin checks, client keys, Zod-validated input and CLI output, secrets never passed to children |

## Data flow (DATA-1)

The full map lives next to the adapter in `docs/providers/claude-sub.md`.

| Feature | Data sent | Redaction | Provider / region | Stored in (logs, memory, vendor) |
|---|---|---|---|---|
| Chat through the Claude subscription | the caller's messages and system prompt; a multi-turn chat gets the versioned transcript wrapper, a single message is passed unchanged | none by default; sapi adds no data of its own | Anthropic, through the `claude` CLI; `inference_geo: global` reported by the CLI | one metadata row per request in sapi's SQLite, no bodies; CLI session files off |
| Chat through the ChatGPT subscription (Phase 3) | the caller's messages | none by default | OpenAI Responses API, `store: false` | request metadata only |

## Status of the 42

Status: **Met** (enforced + passing check) · **Partial** · **Gap** · **Risk** · **N/A** (reason) ·
**Human** (owned by a person) · **Exception** (accepted risk).

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| GOV-1 | Maintain an AI bill of materials | Partial | AI-BOM above, written by hand and checked against the scanner; generation from provider manifests in CI still to do |
| GOV-2 | AI policy and risk assessment | Human | Draft in `docs/threat-model.md`; the maintainer signs it |
| GOV-3 | Notify customers of AI changes | N/A | No customers: every user runs their own copy. An AI changes section is kept in `CHANGELOG.md` anyway |
| GOV-4 | Define agent autonomy and owner | Partial | Agent register above, reviewed 2026-11-27; zero tools enforced in code and tested in `test/unit/claude-stream.test.ts` and `test/security/env-scrub.test.ts`. Missing: a named owner |
| DATA-1 | Map data reaching models | Met | `docs/providers/claude-sub.md` (data flow next to the adapter code) |
| DATA-2 | Minimise data sent to models | Met | `test/security/env-scrub.test.ts`: a single message reaches the CLI byte for byte, client text never reaches argv; multi-turn wrapper tested in `test/unit/core.test.ts` |
| DATA-3 | No provider training; bounded retention | Partial | sapi can't read or change Claude's model-training setting, so `sapi setup` tells the user to check it once (`src/setup/setup.ts`). Missing: `store: false` for ChatGPT in code (Phase 3) and log retention |
| DATA-4 | Control inference location | N/A | Subscription plans offer no region choice; comes into scope with Bedrock, Vertex and Azure (0.3) |
| DATA-5 | Isolate and purge agent memory | Partial | Nothing conversational is stored: no bodies, `--no-session-persistence`, per-request work dirs deleted (`test/security/env-scrub.test.ts`). Phase 5 session reuse needs per-client keys, TTL and purge |
| AUTH-1 | Per-agent identity | Met | `test/security/http.test.ts`: one key per client, model and provider scope, expiry, disable, rotation (`test/unit/cli.test.ts`). Setup's first key is shown once, or written to a 0600 env file, never to the progress log; names starting `sapi-` are reserved (`test/security/setup.test.ts`); `doctor` flags keys older than 180 days |
| AUTH-2 | Never exceed the user's permissions | Met | `test/security/http.test.ts`: identity only from the key (body `user` ignored), the client key never reaches the provider, scope enforced on chat and `/v1/models` |
| AUTH-3 | Approval for consequential actions | N/A | sapi executes no tools and takes no consequential actions; tool calls (Phase 5) go back to the caller. The scanner now detects a vendor SDK (`openai`, dev dependency for contract tests), so this N/A needs an Exceptions row signed by the maintainer |
| AUTH-4 | Kill switch and hard limits | Met | `test/security/kill-switch.test.ts`: global, provider and client switches stop a running stream within a second and refuse the next call; request and token budgets, per-key concurrency and rate limits halt with 429; timeouts in `src/gateway.ts` |
| INJ-1 | Inventory untrusted inputs | Partial | Trust-boundary table above; needs a dated review by the maintainer |
| INJ-2 | Break the lethal trifecta | Met | `test/security/confinement.test.ts` (no private data, no direct network, proxy refuses non-allowlisted hosts) and `test/unit/claude-stream.test.ts` (tools or MCP servers abort the request) |
| INJ-3 | Contain injection in code | Partial | Role tags escaped in the transcript template (`test/unit/core.test.ts`). The dashboard (Phase 4) still needs text-only rendering and its XSS tests |
| INJ-4 | Deny-by-default egress | Partial | `test/security/egress.test.ts` (allowlist, IP literals, private and metadata answers, rebinding) and `test/security/confinement.test.ts` pass on macOS. The Linux launchers haven't run yet |
| INJ-5 | No secrets in prompts | Met | `test/unit/core.test.ts` scans `src/prompts/`; `ari42_scan.py check` is clean |
| OUT-1 | Validate model output before sinks | Met | `test/unit/claude-stream.test.ts` (every CLI line Zod-parsed, unknown lines dropped), `test/security/env-scrub.test.ts` (argv from config only, flag-like model IDs refused), `test/security/http.test.ts` (flag-like aliases → 400); SQL is fixed and parameterised (`src/db.ts`) |
| OUT-2 | Disclose AI; guard user-facing output | N/A | No end-user chat surface; apps built on sapi own their disclosure |
| OUT-3 | People in decisions about people | N/A | sapi makes no decisions about people |
| OUT-4 | Sandbox agent-generated code | Partial | `test/security/confinement.test.ts` passes under sandbox-exec: not root, no `~/.ssh`, no sapi data or config, no writes outside the work dir, profile and (macOS, CLI sign-in) the login keychain folder, no direct network. The keychain folder is writable because the CLI saves refreshed sign-ins there itself; `test/unit/core.test.ts` checks it stays closed unless the adapter asks for it. The child can't install a launchd agent or systemd unit (same test). bwrap and the systemd fallback haven't run yet; memory limits only apply with the systemd fallback |
| MCP-1 | Allowlist and pin servers and skills | Met | The child loads zero MCP servers, plugins and skills (`--strict-mcp-config` with an empty config, `--safe-mode`), enforced at init and tested in `test/unit/claude-stream.test.ts`; no `.mcp.json` in the repo; ARI-42 skill pinned by commit |
| MCP-2 | Detect tool-description changes | N/A | sapi consumes no third-party tools or MCP servers |
| MCP-3 | Authenticate exposed MCP/agent APIs | Met | `test/security/http.test.ts` and `test/security/auth-everywhere.test.ts`: no key → 401, wrong Host → 403, foreign Origin or cross-site → 403, rate limit → 429, client key on `/api` → 403, loopback-only bind, no CORS. The background service runs the same loopback-only server; a keyless call to the launchd agent got 401 when checked by hand (`docs/phase2-notes.md`) |
| MCP-4 | Sandbox MCP servers | N/A | sapi launches no MCP servers |
| GW-1 | Protect provider keys | Met | `test/security/env-scrub.test.ts`: the child environment is an allowlist and none of sapi's secrets reach it; the `auth = "env"` token is read from a 0600 file and passed only to the child. `test/unit/core.test.ts`: one redactor for logs. gitleaks runs in CI. The launchd plist and systemd unit hold paths only, whatever the environment holds (`test/unit/setup.test.ts`); Anthropic's installer runs with a minimal environment. sapi holds no provider keys yet (ChatGPT tokens arrive in Phase 3 with the secret store) |
| GW-2 | Agent stack as critical supply chain | Partial | `test/unit/repo-policy.test.ts` (lockfile hashes, SHA-pinned actions, digest-pinned dev container); the `claude` version range is checked before every run (`src/providers/claude-sub/adapter.ts`); every endpoint authenticated (`test/security/auth-everywhere.test.ts`). `scripts/install.sh` installs only a binary that matches `SHA256SUMS`, refuses non-https sources, and refuses an unsigned release when asked (`test/security/install-script.test.ts`); setup installs only the tested `claude` version, through Anthropic's installer, following redirects only to Anthropic's hosts (`test/unit/setup.test.ts`). Missing: signed releases, provenance, SBOM (Phase 5) |
| GW-3 | Pin models; evaluate before switching | Partial | Aliases map to full IDs and "-latest" is refused (`test/unit/core.test.ts`). Missing: `sapi eval` before a mapping change |
| LOG-1 | Log every agent run | Partial | One hash-chained, metadata-only row per request with the template version (`test/security/kill-switch.test.ts`, `test/unit/core.test.ts`); one redactor; `sapi doctor` verifies the chain and catches a row deleted outside sapi (`test/security/setup.test.ts`). Missing: retention and purge (`sapi purge`) |
| LOG-2 | Detect abnormal agent behaviour | Gap | The inputs are recorded (auth failures, blocked egress, kill switches, unsafe child init) but nothing alerts yet: Phase 4 |
| LOG-3 | Plan for AI incidents | Human | Runbooks drafted in Phase 5; the maintainer owns them |
| LOG-4 | Customer access to agent records | N/A | Not multi-tenant; `sapi export --client` is planned anyway |
| EVAL-1 | Gate releases on security evals | Partial | `test/security/` runs on every CI build with zero failures allowed, and CI fails if the confinement suite would skip; install, setup, the service, doctor and uninstall are checked by hand (`docs/phase2-notes.md`; no install workflow, at the owner's request). Becomes a required check when the repository is published with branch protection |
| EVAL-2 | Independent adversarial testing | Human | Before 1.0, then yearly |
| EVAL-3 | Version prompts and config as code | Met | `src/prompts/transcript-v1.ts` is versioned; the version is logged on every request (`test/security/kill-switch.test.ts`) |
| SDLC-1 | Approve coding assistants | Human | Policy drafted in `CONTRIBUTING.md` (AI-assisted contributions); the maintainer signs |
| SDLC-2 | Sandbox coding agents | Partial | Dev container `.devcontainer/devcontainer.json`; `test/unit/repo-policy.test.ts` fails on bypass flags in `src/` and `scripts/`; no managed policy for contributors' own machines |
| SDLC-3 | Review AI-written code | Partial | CodeQL, gitleaks, dependency review workflows in `.github/workflows/`; branch protection set when the repo is published |
| SDLC-4 | Protect agent configuration | Partial | sapi's Claude profile is separate from the user's, and the child can't read or write sapi's config or database (`test/security/confinement.test.ts`); policy changes only through the CLI, never over HTTP (`test/security/auth-everywhere.test.ts`); the child can't write a launchd agent or systemd unit (`test/security/confinement.test.ts`); CODEOWNERS covers the installer, service and sandbox code. Missing: a real handle in `.github/CODEOWNERS` |
| SDLC-5 | Isolate CI agents | Met | No AI step runs in CI. `test/unit/repo-policy.test.ts` checks every workflow: read-only token by default, no `pull_request_target` or `issue_comment` trigger, SHA-pinned actions, no persisted credentials, no agent steps |
| SDLC-6 | Block hallucinated packages | Met | `test/unit/repo-policy.test.ts` checks exact versions, an integrity hash for every locked package, and Renovate's 7-day minimum release age; CI installs with `--frozen-lockfile`. Phase 1's two new packages (`zod` 4.6.7, `openai` 7.61.0) were checked on npm: intended package, years old, release older than 7 days |

## Exceptions

| ID | What is not met | Why accepted | Accepted by | Review by |
|---|---|---|---|---|

## Notes on scanner findings

`ari42_scan.py check` is clean. Test files build credential-shaped strings, the all-interfaces
address and bypass-looking flags from parts at runtime (`fakeSecret` in `test/helpers.ts`), so
neither this scanner nor gitleaks mistakes test inputs for leaks.

## Needs a human

- [ ] Name the owner for AI security (top of this file and `GOVERNANCE.md`).
- [ ] GOV-2: review and sign `docs/threat-model.md`.
- [ ] SDLC-1: confirm the AI-assisted contribution policy in `CONTRIBUTING.md`.
- [ ] SDLC-4: replace the placeholder handle in `.github/CODEOWNERS`, and the same placeholder in `REPO` at the top of `scripts/install.sh` (the installer refuses to guess a download source until then).
- [ ] AUTH-3: sign the N/A as an exception. The scanner now detects a vendor SDK (`openai`, used only by the contract tests).
- [ ] INJ-1: review the trust-boundary table and date it.
- [ ] LOG-3 and EVAL-2: own the incident runbooks and the independent review (later phases).

## Change log

| Date | Change | Requirements touched | Status after |
|---|---|---|---|
| 2026-11-27 | Phase 0: repository skeleton, CI, Claude CLI probes and fixtures, ARI-42 installed | GOV-1, GOV-4, INJ-2, INJ-4, OUT-4, MCP-1, GW-1, GW-2, SDLC-2–6 | 2 of 34 met |
| 2026-11-27 | Phase 2: `sapi setup` (guided and `--yes`), `doctor`, `connect`, launchd and systemd user service, `start`/`stop`, `uninstall [--purge]`, `scripts/install.sh` with checksum and optional signature check, Claude CLI install through Anthropic's installer, `docs/vm-setup.md` | DATA-3, AUTH-1, OUT-4, MCP-3, GW-1, GW-2, LOG-1, EVAL-1, SDLC-4 | 14 of 34 met; DATA-3 Gap → Partial |
| 2026-11-27 | Phase 1 real-Claude run: per-request `HOME` gets a `Library/Keychains` link on macOS (the CLI's sign-in lives in the login keychain), and the sandbox lets the CLI write that folder; `scripts/e2e/real-claude.ts` | OUT-4, INJ-2, DATA-1, EVAL-1 | unchanged: 14 of 34 met |
| 2026-11-27 | Phase 1: gateway core (HTTP guards, client keys, rate limits, budgets, kill switches, scheduler, hash-chained meter), `/v1/chat/completions` and `/v1/models`, Claude adapter with sandbox-exec, bwrap and systemd launchers and the egress proxy; security suite in `test/security/`; contract tests with openai-node, openai-python and LangChain | DATA-1, DATA-2, DATA-5, AUTH-1, AUTH-2, AUTH-3, AUTH-4, INJ-2–5, OUT-1, OUT-4, MCP-1, MCP-3, GW-1–3, LOG-1, LOG-2, EVAL-1, EVAL-3, SDLC-4, SDLC-6 | 14 of 34 met |
