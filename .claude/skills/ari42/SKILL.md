---
name: ari42
description: Primary build guideline for any software that involves AI agents or LLMs. Use it before writing, changing or reviewing code that touches agent loops, tool or function calling, MCP servers or clients, A2A, agent SDKs and frameworks (Claude Agent SDK, OpenAI Agents, LangChain, LangGraph, CrewAI, ADK, Vercel AI SDK, Mastra and similar), RAG, vector stores or agent memory, code interpreters and sandboxes, LLM gateways or self-hosted models, skills and plugins, chat UIs that render model output, coding-agent config (AGENTS.md, CLAUDE.md, .mcp.json, hooks) or AI steps in CI. It scopes which of the 42 ARI-42 security requirements apply to the project, plans the controls for the feature being built, builds them in by default, verifies them with tests, and keeps an ARI42.md compliance record.
---

# ARI-42: build agent software that is secure by default

ARI-42 is 42 security requirements for software that uses AI agents, drawn from OWASP, CSA,
CoSAI, MITRE ATLAS, NIST, ISO 42001, the MCP spec and national guidance, and tested against 85
agent tools and the 7,257 AI CVEs of 2025–26. About 95% of those CVEs map to one of the 42.

The research finding that shapes this skill: **agent tools almost never do the security work for
you.** Only 3% of the requirements were met by a tool's default. In 15% the tool's default works
against you. So when you build with any agent component, you add the controls yourself, in code,
on by default, and you prove each one with a test.

## When this skill is in charge

Use it for **any** task in a project that involves agents or LLMs: new features, bug fixes,
refactors, dependency changes, config edits, reviews. If the project has any AI component, these
are the primary guidelines; they take precedence over a framework's quick-start defaults.

If the user asks for something that would break an applicable requirement (run model output with
`eval`, add a "yolo"/skip-permissions flag, expose an MCP server without auth, pass the user's
token to a third-party tool), do not silently comply and do not silently refuse. Say which
requirement it breaks and why, offer the secure way to get the same result, and only proceed if
the user explicitly accepts the risk. Record it as an **Exception** in `ARI42.md` with reason,
owner and review date.

## The workflow

Follow these five steps. Steps 1 is once per project (refresh when the AI stack changes); steps
2–5 run on every task.

### 1. Scope the project (once, then keep current)

1. Run the detector from the skill folder:
   `python3 <skill-dir>/scripts/ari42_scan.py detect <project-root>`
   It lists agent components (frameworks, SDKs, MCP, memory, sandboxes, gateways, low-code,
   skills, CI agents) and the requirements each switches on.
2. Read the code paths the detector points at; it is a heuristic, so confirm by reading.
3. Apply the project lens in `references/applicability.md` to decide, for all 42, **in scope** or
   **N/A with a checkable reason**. When unsure, keep it in scope.
4. Create or update `ARI42.md` at the project root from `templates/ARI42.md`: AI-BOM, agent
   register, trust boundaries, and the status table for all 42.

If `ARI42.md` already exists, read it first and treat it as the project's current state.

### 2. Plan the feature against the in-scope requirements

Before writing code, match the change to the feature lens in `references/applicability.md`. For
each requirement it touches, read its entry in `references/questionnaire.md` and decide what the
code must do. State the plan briefly to the user, for example:

> This adds a `send_invoice` tool. ARI-42 in play: AUTH-2 (acts for the user), AUTH-3 (sending is
> consequential, so approval bound to the arguments), OUT-1 (validate the amount and recipient),
> LOG-1 (log the call). I'll build those in.

### 3. Build the controls in, by default

Write the feature with the controls already in it. Use `references/secure-patterns.md` for the
implementation and `references/component-playbooks.md` for the traps of the specific framework,
SDK, MCP library, memory layer or sandbox in use.

These ten rules carry most of the risk (the requirements behind 86% of AI CVEs, plus the most
common unsafe defaults). Treat them as non-negotiable wherever they apply:

1. **OUT-4** Agent-generated code and commands run only in a disposable per-session sandbox:
   non-root, no host filesystem, no secrets, no network unless allowlisted. Never `eval`/`exec`
   model or memory content in-process.
2. **OUT-1** Model output is validated against a schema before any sink. Parameterised SQL, argv
   arrays (never `shell=True` with model text), escaped HTML, paths kept inside a root.
3. **AUTH-2** Identity and tenant come from the authenticated session, never from model
   arguments. Every tool and retrieval query enforces the user's own permissions. Never forward
   the user's token to third-party tools; sub-agents get narrower scope, never wider.
4. **MCP-3** Any MCP server, agent API or dev console you expose has authentication on by default,
   binds to loopback when local, validates token audience, is tenant-scoped and rate-limited.
5. **INJ-4** Agent runtimes, sandboxes and fetch tools have deny-by-default egress with an
   allowlist and SSRF protection (no private, link-local or metadata addresses).
6. **INJ-3** Tool results and retrieved content are data, not instructions. UIs never render
   images or links to arbitrary domains from model output.
7. **GW-1 / MCP-4** Subprocesses, shells and MCP stdio servers get an explicit minimal
   environment. Provider keys never reach the agent's commands, prompts or the browser.
8. **AUTH-3** Consequential actions (send, pay, delete, deploy, export, call) need a human
   approval rendered from the real arguments, bound to them, enforced outside the model.
9. **DATA-5** Memory and vector stores are tenant-isolated on the server, carry write
   provenance, support purge-by-source and retention, and never store credentials.
10. **GW-2 / MCP-1 / SDLC-6** Pin the agent stack: hashed lockfiles, exact MCP server and skill
    versions, image and model digests, safe model formats. Check that an agent-suggested package
    exists and is not brand new before adding it.

And the design rule under all of them: **enforcement lives in code outside the model.** Prompts,
guardrail classifiers and system instructions may add friction, never grant permission. Assume
the model can be fully hijacked by injected content and make sure the worst case is still safe.

Do not trust a component's documentation about its defaults. Read the code path in the installed
version or test it. The audit found docs that described safer defaults than the code shipped.

### 4. Verify with evidence

A requirement is **Met** only when there is a passing check. For each requirement the change
touched:

1. Write or update the test named in its **Verify** line in `references/questionnaire.md`
   (sandbox cannot see host or keys; cross-tenant query returns nothing; changed arguments
   invalidate approval; unauthenticated request gets 401; markdown image to an outside domain
   is not rendered).
2. Run the heuristic scanner and fix or justify every finding:
   `python3 <skill-dir>/scripts/ari42_scan.py check <project-root>`
3. Run the project's test suite.
4. Run the gate, which is what CI runs:
   `python3 <skill-dir>/scripts/ari42_scan.py verify <project-root>`
   It passes only when **every requirement that applies to this project** is Met, or is an
   accepted exception. Applicable means every row of the status table not marked N/A. It is not
   just the requirements this change touched.

Never report a requirement as Met because the code "looks right". If you could not run the check,
say so and mark it Partial.

### 5. Record and report

Update `ARI42.md`: status of each touched requirement (Met / Partial / Gap / Risk / N/A / Human /
Exception), the evidence, and anything new in the AI-BOM, agent register or trust boundaries.

Write the status table so the gate (`verify`) can check it:

- **All 42 rows stay in the table.** Scope by status, never by deleting rows.
- **Statuses are project-wide.** Never write "Met (this feature)" or "N/A (memory tools)". If a
  requirement is met for the code you changed but not everywhere it applies, it is Partial, and
  the evidence column says what is still missing.
- **N/A** needs a reason. If the scanner detects a component that switches the requirement on,
  N/A also needs a row in the Exceptions table naming the person who accepted it. Never mark a
  detected requirement N/A on your own.
- **Met** needs evidence that exists in the repo, written as a path in backticks
  (`tests/test_tool_gateway.py`). This depends on the Gate value in `references/questionnaire.md`:
  - `release` requirements must cite a test, eval or CI file that runs on every build.
  - `partly` requirements must cite a file in the repo.
  - `periodic` requirements must cite a file or a link to the signed record, with the date of
    the last review (YYYY-MM-DD). Evidence older than a year fails.
- A requirement with a high-severity scanner finding cannot be Met.
- **Exception** needs a row with **Accepted by** (a person, never the agent) and a future
  **Review by** date.

Then tell the user, briefly:

- which requirements this change touched and their status now,
- any **Risk** or **Gap** left, with the fix,
- any **Human** items (policy, contracts, red-team, incident plan) that need a person.

Do not claim the project is "ARI-42 compliant" while any in-scope requirement is Gap, Risk or
unverified. Say "N of M in-scope requirements met, with evidence" instead.

## Reviewing existing code

When asked to review or audit, run step 1, then go through every in-scope requirement in
`references/questionnaire.md`, answer its **Question** with evidence from the code, and rate it
with the status vocabulary. Report Risks first, then Gaps, then Partials, each with the file,
the requirement and the concrete fix.

## Files in this skill

| File | Read it when |
|---|---|
| `references/questionnaire.md` | Planning or verifying any requirement: the 42 questions with build and verify steps |
| `references/applicability.md` | Scoping a project (project lens) or a change (feature lens); status vocabulary |
| `references/secure-patterns.md` | Writing the control: sandbox, env scrub, tool gateway, approvals, limits, memory, output validation, safe rendering, egress, MCP auth, pinning, logging, CI, evals |
| `references/component-playbooks.md` | Building on a specific framework, SDK, harness, MCP library, skill registry, memory layer, sandbox or low-code builder |
| `references/evidence-base.md` | Explaining why a requirement matters; the research numbers |
| `templates/ARI42.md` | Creating the project's compliance record |
| `scripts/ari42_scan.py` | `detect` components and scope; `check` for common unsafe patterns; `verify` the ARI42.md gate CI runs |
| `templates/ari42-gate.yml` | Adding the gate to GitHub Actions (the installer's `--ci` does this) |
