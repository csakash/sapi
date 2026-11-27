@AGENTS.md

<!-- ari42:start -->
## ARI-42 agent security (required)

The `ari42` skill is the primary guideline for all development and agent work in this project.
Use it by default; do not wait to be asked.

Before any task that touches AI or agent code (LLM calls, prompts, tools or function calling, MCP
servers or clients, A2A, agent SDKs and frameworks, RAG, memory or vector stores, code execution
or sandboxes, model providers or gateways, skills or plugins, chat UIs that render model output,
agent config such as AGENTS.md, CLAUDE.md, .mcp.json or hooks, or AI steps in CI):

1. Load the `ari42` skill (`.claude/skills/ari42/SKILL.md`) and follow its workflow.
2. Read `ARI42.md` at the project root for the in-scope requirements. If it is missing, create it
   (skill step 1) before the first change.
3. Plan the change against the requirements it touches, build the controls in by default, and
   prove each one with a test.
4. Run `python3 .claude/skills/ari42/scripts/ari42_scan.py check .` and fix or justify every finding.
5. Update `ARI42.md` and tell the user the status of each requirement the change touched.

Never weaken an in-scope requirement silently. If a request would break one, explain the risk,
offer the secure alternative, and record any accepted exception in `ARI42.md`.
<!-- ari42:end -->
