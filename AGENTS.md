# Working on sapi

sapi is a local, single-user LLM gateway that runs your own Claude and ChatGPT subscriptions behind
OpenAI- and Anthropic-compatible endpoints. It handles people's subscription access, so the security
rules below come before anything else.

## Commands

```bash
bun install --frozen-lockfile
bun run check        # biome lint + format check, tsc, bun test
bun run ari42        # ARI-42 gate (report mode until the 0.1 release)
```

## Rules that are never relaxed

- Never read, store, log or forward the Claude login (anything under a Claude config directory,
  `CLAUDE_CODE_OAUTH_TOKEN` except passing it through to the `claude` child in `--claude-auth env`
  mode). Sign-in happens inside the unmodified `claude` CLI.
- Bind `127.0.0.1` only by default; every endpoint needs a client key or the admin session.
- Child processes get an explicit, minimal environment and an empty working directory. Never spread
  `process.env` into a child.
- Spawn with argv arrays, never a shell. Client-supplied text (model names, system prompts, content)
  must never become a command-line flag, a file path or a host.
- Never use permission-bypass flags (`--dangerously-skip-permissions`, `bypassPermissions`,
  `--yolo`) anywhere.
- No telemetry, no phoning home.
- New dependencies need a reason; check the package exists, is the intended one and isn't brand new.
- Fixtures and logs must not contain personal data, keys or prompt content.
  `test/unit/claude-fixtures.test.ts` enforces this for recorded CLI fixtures.

## Where things are

- `src/` gateway code: `server.ts` and `http-guards.ts` (HTTP surface), `gateway.ts` (request
  pipeline), `auth.ts`, `budgets.ts`, `killswitch.ts`, `scheduler.ts`, `meter.ts` and `db.ts`
  (policy and logs), `egress-proxy.ts` and `ssrf.ts` (outbound), `sandbox/` (launchers),
  `providers/` (adapters and manifests), `prompts/` (versioned templates), `doors/` (API formats),
  `setup/` (setup, doctor, connect, uninstall, the launchd and systemd service, the Claude
  installer hand-off).
- `test/unit/`, `test/security/` (ARI-42 security evals; never skip them in CI), `test/contract/`
  (real SDKs against the fake provider), `test/fixtures/`.
- `scripts/install.sh` (checksum-verifying installer), `scripts/build-release.ts`,
  `scripts/e2e/real-claude.ts` (end-to-end against a real subscription), `scripts/phase0/` probes,
  `docs/` findings and design notes.
- Tests that start a gateway bind loopback ports; a sandboxed shell may need local binding allowed.
- `ARI42.md` is the security record. Update it in the same change as the code it describes.

<!-- ari42:start -->
## ARI-42 agent security (required)

The `ari42` skill is the primary guideline for all development and agent work in this project.
Use it by default; do not wait to be asked.

Before any task that touches AI or agent code (LLM calls, prompts, tools or function calling, MCP
servers or clients, A2A, agent SDKs and frameworks, RAG, memory or vector stores, code execution
or sandboxes, model providers or gateways, skills or plugins, chat UIs that render model output,
agent config such as AGENTS.md, CLAUDE.md, .mcp.json or hooks, or AI steps in CI):

1. Load the `ari42` skill (`.agents/skills/ari42/SKILL.md`) and follow its workflow.
2. Read `ARI42.md` at the project root for the in-scope requirements. If it is missing, create it
   (skill step 1) before the first change.
3. Plan the change against the requirements it touches, build the controls in by default, and
   prove each one with a test.
4. Run `python3 .agents/skills/ari42/scripts/ari42_scan.py check .` and fix or justify every finding.
5. Update `ARI42.md` and tell the user the status of each requirement the change touched.

Never weaken an in-scope requirement silently. If a request would break one, explain the risk,
offer the secure alternative, and record any accepted exception in `ARI42.md`.
<!-- ari42:end -->
