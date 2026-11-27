# Scoping: which of the 42 apply

Two lenses. Use the **project lens** once per project (and whenever the AI-BOM changes) to decide
which requirements are in scope. Use the **feature lens** on every task to decide which in-scope
requirements the change touches.

Never mark a requirement N/A without a reason a reviewer can check ("no memory store in the AI-BOM").
When unsure, keep it in scope.

## 1. Project lens: components → requirements

Start from `python3 scripts/ari42_scan.py detect`. Each detected component switches on a set of
requirements. The union is the project's scope.

| Component found | Category | Requirements switched on |
|---|---|---|
| Any LLM call at all | baseline | GOV-1, GOV-2, GOV-4, DATA-1, DATA-3, INJ-1, INJ-5, GW-1, GW-3, LOG-1, EVAL-1, EVAL-3, SDLC-3, SDLC-6 |
| Agent loop / tool calling (any framework or vendor SDK) | framework, vendor SDK | AUTH-1, AUTH-3, AUTH-4, INJ-2, INJ-3, OUT-1, LOG-2, GW-2 |
| Agent acts for a signed-in user, multi-tenant, RAG over shared data | — | AUTH-2, DATA-5, LOG-4 |
| Code interpreter, shell, REPL, notebook or "run code" tool | — | OUT-4, INJ-4 |
| Coding-agent harness embedded in the product (Claude Agent SDK, Codex SDK, OpenHands, goose…) | harness | OUT-4, INJ-4, GW-1 (env scrub), SDLC-4, AUTH-3, AUTH-4 |
| MCP client (consumes servers) | MCP | MCP-1, MCP-2, MCP-4, INJ-1 |
| MCP server or A2A / agent HTTP endpoint you expose | MCP | MCP-3, MCP-4, AUTH-2, LOG-1 |
| Skills, plugins, rules files | skills | MCP-1, MCP-2, SDLC-4 |
| Memory layer, vector store, semantic cache, conversation store | memory | DATA-5, AUTH-2, INJ-1, OUT-1 |
| Sandbox SDK (E2B, Daytona, Modal, microVMs, containers) | sandbox | OUT-4, INJ-4, LOG-2, GW-1 (no keys inside) |
| Low-code builder (Flowise, Langflow, Dify, n8n, Botpress…) | low-code | GW-2, MCP-3, INJ-3, OUT-4, AUTH-3 |
| LLM gateway or self-hosted inference (LiteLLM, vLLM, Ollama, Ray, Triton, TGI) | gateway | GW-2, GW-1, MCP-3 (endpoints), INJ-4 |
| Chat UI that renders model output (markdown, HTML) | — | INJ-3, OUT-2 |
| End users talk to the agent (chat, voice, email) | — | OUT-2 |
| Output drives decisions about people | — | OUT-3 |
| Personal or confidential data reaches a model | — | DATA-2, DATA-4 |
| Model writes SQL, shell, HTML, file paths, API calls | — | OUT-1 |
| AI actions or agent CLIs in CI workflows | — | SDLC-5, SDLC-2 |
| Engineers use coding agents on this repo | — | SDLC-1, SDLC-2, SDLC-4 |
| B2B customers / regulated buyers | — | GOV-3, LOG-3, LOG-4, EVAL-2, DATA-4 |

Organisational items (GOV-2, GOV-3, DATA-3 contract part, LOG-3, EVAL-2, SDLC-1) are owned by a
person. The agent drafts what it can and lists them under "Needs a human" in `ARI42.md`. Never
mark them Met on the agent's own authority.

## 2. Feature lens: what this change touches

Before writing code, match the change to these patterns. Every row hit adds its requirements to
the task's checklist, and they must be Met (or recorded as an accepted exception) before you say
the work is done.

| The change… | Check these before and after coding |
|---|---|
| adds or edits a tool the agent can call | AUTH-1, AUTH-2, AUTH-3 (classify read/write/consequential), OUT-1, LOG-1, GOV-4 register |
| adds a tool that fetches URLs, browses, reads email/tickets/files | INJ-1, INJ-2, INJ-3, INJ-4 (SSRF + allowlist) |
| lets the agent run code or commands | OUT-4, INJ-4, GW-1 (env scrub), AUTH-4 |
| adds memory, RAG, embeddings, a vector store or caching | DATA-1, DATA-5, AUTH-2 (filter in query), INJ-1 |
| exposes an endpoint (MCP server, agent API, webhook that triggers an agent) | MCP-3, MCP-4, AUTH-2, LOG-1, AUTH-4 (rate limits) |
| adds an MCP server, plugin, skill or A2A peer to a config | MCP-1, MCP-2, MCP-4, GOV-1 |
| renders model output in a UI | INJ-3, OUT-2 |
| sends model output to SQL, shell, HTML, files, another API or another agent | OUT-1 |
| adds or switches a model or provider | GW-3, DATA-3, DATA-4, GOV-1, GOV-3, EVAL-1 |
| adds multi-agent delegation or sub-agents | AUTH-2 (scope narrowing), INJ-1 (sub-agent output untrusted), LOG-1 |
| changes prompts or agent config | EVAL-3, INJ-5, SDLC-4 |
| adds a dependency from the agent stack | GW-2, SDLC-6, GOV-1 |
| adds an AI step to CI | SDLC-5, SDLC-3 |
| touches approval, autonomy or limits | AUTH-3, AUTH-4, GOV-4, SDLC-4 |
| adds logging, tracing or an observability vendor | LOG-1 (redaction applies to vendor), DATA-1 |
| ships a new agent feature to users | EVAL-1, GOV-2, OUT-2, LOG-2, LOG-3 |

## 3. Status vocabulary

The same scale the ARI-42 index uses to rate tools, applied to your project:

| Status | Meaning |
|---|---|
| **Met** | Enforced by code or infra, on by default, with a passing check. |
| **Partial** | Some of it exists, or it is off by default, or it rests on configuration nobody tested. |
| **Gap** | Nothing in the project does it yet. |
| **Risk** | Something in the project works against it (an unsafe default, a vulnerable version, `eval` on model output). Fix before release. |
| **N/A** | Does not apply, with a checkable reason. |
| **Human** | Organisational item; drafted by the agent, owned and signed by a person. |
| **Exception** | Knowingly not met; user accepted the risk; reason, owner and review date recorded. |
