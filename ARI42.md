# ARI-42 record: sapi

Security record for the AI and agent parts of this project, kept by the coding agent under the
ARI-42 skill and reviewed by people. Update it in the same change as the code.

- **Last reviewed:** 2026-11-27 (Phase 0)
- **Owner for AI security:** _to be named by the maintainer (see GOVERNANCE.md)_
- **Score:** 2 of 34 in-scope requirements met with evidence · 0 Risk · 13 Gap · 15 Partial · 4 Human

Scope follows the project lens for what sapi is being built to be (an LLM gateway that embeds the
`claude` coding-agent CLI and exposes an agent HTTP endpoint), not only what the scanner finds in
today's skeleton. Phase 0 has no gateway code yet, so most rows are Gap or Partial on purpose. The CI
gate runs in report mode until the 0.1 release, then blocks.

## AI-BOM (GOV-1)

Checked by hand against `python3 .agents/skills/ari42/scripts/ari42_scan.py detect . --json`
(which finds only coding-agent configuration so far). CI generation of this table lands in Phase 1.

| Component | Kind | Version / pin | Where | Data it can reach | Owner |
|---|---|---|---|---|---|
| Claude Code CLI (`claude`) | coding-agent harness, run as a child process | 2.1.332 tested; supported range set in Phase 1 | `scripts/phase0/claude-probe.ts` (Phase 1: `src/providers/claude-sub/`) | the prompt sapi passes; its own login in sapi's profile | maintainer |
| claude-haiku-5-5 (alias `haiku`) | model | full ID resolved by the CLI; Phase 1 config pins full IDs | Phase 0 probes only | short test prompts | maintainer |
| ChatGPT subscription via Sign in with ChatGPT | provider (planned, Phase 3) | — | — | request content | maintainer |
| ARI-42 skill | engineering skill | warden/ari42-skill commit `6a4f8a48dfa4` (v1.1.0) | `.agents/skills/ari42/`, `.claude/skills/ari42/` | repository files | maintainer |
| Biome, TypeScript, @types/bun | development tools | exact versions with integrity hashes in `bun.lock` | `package.json` | none | maintainer |

## Agent register (GOV-4)

| Agent | Tools (read / write / consequential) | Autonomy | Approval required for | Accountable owner |
|---|---|---|---|---|
| Claude child process (`claude -p`) | none: `--tools ""`, empty strict MCP config; the CLI's output-only `StructuredOutput` tool appears only with `--json-schema` | suggest only: returns text or JSON, never acts | nothing: sapi never executes tool calls, it returns them to the caller | maintainer |

## Trust boundaries (INJ-1, INJ-2)

| Agent | Untrusted inputs (who can write them) | Private data | Exfiltration paths | Control that breaks the trifecta |
|---|---|---|---|---|
| Claude child process | request content from any local client holding a sapi key | none: no file access beyond an empty temp dir, no secrets in its environment | none by design: no tools; network only to the egress proxy, which allows only Anthropic API hosts | no tools + egress allowlist + OS sandbox |
| sapi gateway (not an agent; listed for completeness) | request bodies and headers (local clients; a web page if Host/Origin checks failed), provider responses, CLI stream output, config files | provider tokens (ChatGPT, in the secret store), client key hashes, request metadata | provider APIs only | Host/Origin checks, client keys, secrets never passed to children, egress allowlist |

## Data flow (DATA-1)

| Feature | Data sent | Redaction | Provider / region | Stored in (logs, memory, vendor) |
|---|---|---|---|---|
| Chat through the Claude subscription | the caller's messages and system prompt; sapi adds only a versioned transcript template | none by default; sapi adds no data of its own | Anthropic, through the `claude` CLI; `inference_geo: global` reported by the CLI | request metadata in sapi's SQLite (Phase 1); CLI session files off (`--no-session-persistence`) |
| Chat through the ChatGPT subscription (Phase 3) | the caller's messages | none by default | OpenAI Responses API, `store: false` | request metadata only |

## Status of the 42

Status: **Met** (enforced + passing check) · **Partial** · **Gap** · **Risk** · **N/A** (reason) ·
**Human** (owned by a person) · **Exception** (accepted risk).

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| GOV-1 | Maintain an AI bill of materials | Partial | AI-BOM above, written by hand; CI generation from provider manifests in Phase 1 |
| GOV-2 | AI policy and risk assessment | Human | Draft in `docs/threat-model.md`; the maintainer signs it |
| GOV-3 | Notify customers of AI changes | N/A | No customers: every user runs their own copy. An AI changes section is kept in `CHANGELOG.md` anyway |
| GOV-4 | Define agent autonomy and owner | Partial | Agent register above; `test/unit/claude-fixtures.test.ts` checks recorded runs report no tools. Adapter-level check in Phase 1 |
| DATA-1 | Map data reaching models | Partial | Data-flow table above; must sit next to the adapter code in Phase 1 |
| DATA-2 | Minimise data sent to models | Gap | Phase 1: test that sapi adds nothing beyond the versioned template |
| DATA-3 | No provider training; bounded retention | Gap | Phase 3: `store: false` in code; setup points users to each provider's training setting |
| DATA-4 | Control inference location | N/A | Subscription plans offer no region choice; comes into scope with Bedrock, Vertex and Azure (0.3) |
| DATA-5 | Isolate and purge agent memory | Gap | Phase 5: per-client session reuse with TTL and purge; probes already disable CLI session files |
| AUTH-1 | Per-agent identity | Gap | Phase 1: one scoped key per client |
| AUTH-2 | Never exceed the user's permissions | Gap | Phase 1: identity only from the key; per-client isolation tests |
| AUTH-3 | Approval for consequential actions | N/A | sapi executes no tools and takes no consequential actions; tool calls are returned to the caller. Needs a signed exception once the scanner detects vendor SDKs (Phase 2–3) |
| AUTH-4 | Kill switch and hard limits | Gap | Phase 1: global, provider and client kill switches; budgets that halt |
| INJ-1 | Inventory untrusted inputs | Partial | Trust-boundary table above; needs a dated review by the maintainer |
| INJ-2 | Break the lethal trifecta | Partial | Capability matrix above; `test/unit/claude-fixtures.test.ts` checks no tools and no MCP servers in recorded runs |
| INJ-3 | Contain injection in code | Gap | Phase 1: escaped transcript role tags; Phase 4: text-only dashboard rendering under a strict CSP |
| INJ-4 | Deny-by-default egress | Partial | `scripts/phase0/egress-proxy.ts` enforce mode verified by hand (see `docs/phase0-findings.md`); automated test in Phase 1 |
| INJ-5 | No secrets in prompts | Partial | No prompt templates exist yet; the scanner checks them once they do |
| OUT-1 | Validate model output before sinks | Gap | Phase 1: Zod-parsed stream lines, argv-only spawning, model names only from config |
| OUT-2 | Disclose AI; guard user-facing output | N/A | No end-user chat surface; apps built on sapi own their disclosure |
| OUT-3 | People in decisions about people | N/A | sapi makes no decisions about people |
| OUT-4 | Sandbox agent-generated code | Partial | macOS profile `scripts/phase0/claude-child.sb` verified by hand with the real CLI; Linux layer and automated test in Phase 1 |
| MCP-1 | Allowlist and pin servers and skills | Partial | Recorded runs load zero MCP servers (`test/unit/claude-fixtures.test.ts`); ARI-42 skill pinned by commit in the AI-BOM; no `.mcp.json` in the repo |
| MCP-2 | Detect tool-description changes | N/A | sapi consumes no third-party tools or MCP servers |
| MCP-3 | Authenticate exposed MCP/agent APIs | Gap | Phase 1: keys on every route, loopback bind, Host and Origin checks, rate limits |
| MCP-4 | Sandbox MCP servers | N/A | sapi launches no MCP servers |
| GW-1 | Protect provider keys | Partial | Probe passes an explicit minimal environment (`scripts/phase0/claude-probe.ts`); env-scrub test in Phase 1 |
| GW-2 | Agent stack as critical supply chain | Partial | `test/unit/repo-policy.test.ts` checks the lockfile hashes, SHA-pinned actions and the digest-pinned dev container; `renovate.json` keeps them current. Missing: signed releases and provenance (Phase 5), a tested `claude` CLI version range (Phase 1) |
| GW-3 | Pin models; evaluate before switching | Gap | Phase 1: aliases map to full model IDs, `-latest` refused |
| LOG-1 | Log every agent run | Gap | Phase 1: hash-chained request log, bodies off |
| LOG-2 | Detect abnormal agent behaviour | Gap | Phase 4: alerts |
| LOG-3 | Plan for AI incidents | Human | Runbooks drafted in Phase 5; the maintainer owns them |
| LOG-4 | Customer access to agent records | N/A | Not multi-tenant; `sapi export --client` is planned anyway |
| EVAL-1 | Gate releases on security evals | Gap | Phase 1 onwards: security suite in `test/security/` as a required check |
| EVAL-2 | Independent adversarial testing | Human | Before 1.0, then yearly |
| EVAL-3 | Version prompts and config as code | Gap | Phase 1: templates in `src/prompts/` with the version logged per request |
| SDLC-1 | Approve coding assistants | Human | Policy drafted in `CONTRIBUTING.md` (AI-assisted contributions); the maintainer signs |
| SDLC-2 | Sandbox coding agents | Partial | Dev container `.devcontainer/devcontainer.json`; `test/unit/repo-policy.test.ts` fails on bypass flags in `src/` and `scripts/`; no managed policy for contributors' own machines |
| SDLC-3 | Review AI-written code | Partial | CodeQL, gitleaks, dependency review workflows in `.github/workflows/`; branch protection set when the repo is published |
| SDLC-4 | Protect agent configuration | Partial | `.github/CODEOWNERS` covers agent config and policy paths (maintainer handle still a placeholder) |
| SDLC-5 | Isolate CI agents | Met | No AI step runs in CI. `test/unit/repo-policy.test.ts` checks every workflow: read-only token by default, no `pull_request_target` or `issue_comment` trigger, SHA-pinned actions, no persisted credentials, no agent steps |
| SDLC-6 | Block hallucinated packages | Met | `test/unit/repo-policy.test.ts` checks exact versions, an integrity hash for every locked package, and Renovate's 7-day minimum release age; CI installs with `--frozen-lockfile` |

## Exceptions

| ID | What is not met | Why accepted | Accepted by | Review by |
|---|---|---|---|---|

## Needs a human

- [ ] Name the owner for AI security (top of this file and `GOVERNANCE.md`).
- [ ] GOV-2: review and sign `docs/threat-model.md`.
- [ ] SDLC-1: confirm the AI-assisted contribution policy in `CONTRIBUTING.md`.
- [ ] SDLC-4: replace the placeholder handle in `.github/CODEOWNERS`.
- [ ] AUTH-3: sign the N/A as an exception once the scanner detects vendor SDKs (Phase 2–3).
- [ ] LOG-3 and EVAL-2: own the incident runbooks and the independent review (later phases).

## Change log

| Date | Change | Requirements touched | Status after |
|---|---|---|---|
| 2026-11-27 | Phase 0: repository skeleton, CI, Claude CLI probes and fixtures, ARI-42 installed | GOV-1, GOV-4, INJ-2, INJ-4, OUT-4, MCP-1, GW-1, GW-2, SDLC-2–6 | 2 of 34 met |
