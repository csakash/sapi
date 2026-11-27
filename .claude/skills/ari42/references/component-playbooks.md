# Component playbooks

What the ARI-42 audit of 85 agent tools found about each category's **defaults**, and what you
must add when you build on one. The lesson across all eight: a tool almost never does the work
for you. Only 3% of applicable requirements were met by a built-in default. Another 49% got partial
help (off by default, needs configuration or covers only part). In 34% the builder must do
everything, and in 15% the tool works against the requirement.

So: **assume the default is unsafe until you have read the code path or tested it.** Documentation
is not enough. In at least three audited tools the documentation described a safer default than
the code actually shipped.

Each playbook lists the traps (defaults that came up as Risk) and the controls you add.

---

## Open-source agent frameworks
(LangChain/LangGraph, LlamaIndex, CrewAI, AutoGen/AG2, Haystack, DSPy, smolagents, Pydantic AI, Agno, Mastra, CAMEL, LangChain4j…)

Help in 48% of cells, Risk in 14%.

**Traps**
- First-party "Python", "shell", "REPL" or "code" tools that run model-written code **in the host process or host shell**, with isolation opt-in. This is the single most common Risk (OUT-4).
- Text-to-SQL, graph-query and expression chains that execute model output (OUT-1).
- Loaders and deserialisers (pickle, YAML, prompt-hub objects) that execute content (GW-2, OUT-4).
- Dev servers and workflow servers that start without authentication (MCP-3).
- Advisory history: a CVE does not mean the current version is unsafe, and a clean advisory page does not mean the default is safe. Check the installed version's code path.

**Add**
- Replace any in-process code tool with a sandbox-backed tool (`secure-patterns.md` §1).
- Wrap every tool with the authorisation, approval and logging decorator (§3, §4).
- Pin the framework with a hashed lockfile and watch its advisories (GW-2).

## Vendor agent SDKs and platforms
(OpenAI Agents SDK/AgentKit, Anthropic SDK, Google ADK, Vertex Agent Engine, Vercel AI SDK, Strands, Bedrock AgentCore, Azure Foundry, Microsoft Agent Framework, Cloudflare Agents…)

Help in 64% of cells, Risk in 11%.

**Traps**
- Managed platforms own good controls (region, retention, network, identity) but **many are opt-in, preview or paid-tier**. "Supports X" usually means "you can configure X".
- Built-in code-interpreter tools vary: hosted ones are sandboxed; local "computer" or "shell" tools run on your host.
- Session or conversation IDs used as if they were identity (AUTH-2).

**Add**
- Turn on what the platform offers: zero retention / `store=false`, regional endpoints, guardrails, approval hooks. Record each setting in `ARI42.md`.
- Keep authorisation in your tool handlers, not in the platform's agent instructions.

## Agent harness SDKs
(Claude Agent SDK, OpenAI Codex SDK, GitHub Copilot SDK, Gemini CLI, goose, OpenHands, opencode, Cursor SDK, LangChain Deep Agents, pi…)

Help in 46% of cells, Risk in 17%.

**Traps**
- **Provider keys reach agent-run commands.** With dummy keys in the environment, the default shell or code path of most harnesses passed them to the commands the agent ran (GW-1). 11 harnesses and frameworks did this.
- Permission bypass modes ("yolo", skip-permissions, auto-approve) available as flags (SDLC-2).
- Repo-level config (hooks, MCP configs, rules) loaded before the workspace is trusted (SDLC-4).
- Built-in agent servers and consoles with no authentication (MCP-3).

**Add**
- Run the harness inside a per-session sandbox (OUT-4) with egress denied (INJ-4).
- Pass an explicit, minimal environment to the harness and its tools; never the parent env (GW-1).
- Use the harness's permission hooks/callbacks to enforce AUTH-3 approvals outside the model; never ship bypass modes.
- Restrict allowed tools explicitly; do not rely on defaults.

## MCP SDKs, frameworks and gateways
(official MCP SDKs in TS, Python, Go, C#, Java, Rust, Ruby, PHP, Kotlin, Swift; FastMCP, mcp-use, Inspector, registries, gateways…)

Help in only 32% of cells; **highest Risk share (21%)**.

**Traps**
- **Full environment passed to stdio servers.** Of the 8 official SDKs tested, 6 start local servers with the client's full environment; TypeScript and Python pass a short safelist (MCP-4, GW-1).
- Servers and dev tools that bind to all interfaces with no authentication (MCP-3).
- No built-in detection of tool-description changes (MCP-2: only 23% of tools help).
- Unpinned `npx -y` / `uvx` launches pull whatever is latest (MCP-1).

**Add**
- Explicit `env` for every stdio server; allowlist only the variables it needs.
- Auth on by default for HTTP transports; bind loopback; validate token audience; Origin check.
- Hash tool manifests at approval and compare on connect.
- Pin every server version.

## Agent skill specs, SDKs and registries
Help in 40% of cells, Risk in 11%.

**Traps**
- Skills are instructions plus scripts; a skill can carry a prompt injection or a malicious script. Hundreds of malicious skills were found on one open registry.
- Installers that fetch the latest version from a registry without pinning or review.

**Add**
- Allowlist and pin skills by commit or content hash (MCP-1); review scripts before install; CODEOWNERS on skill paths (SDLC-4).
- A skill can never change approval settings, allowlists or sandbox limits.

## Agent memory SDKs and services
(Mem0, Letta, Zep/Graphiti, Cognee, LangMem, Supermemory, Memori, provider memory tools…)

Help in 48% of cells; second-highest Risk share (18%).

**Traps**
- User or tenant IDs taken from the caller, not enforced by the server (DATA-5, AUTH-2).
- No provenance on writes, so a poisoned memory cannot be traced or purged.
- Memory content later `eval`-ed or used to build queries (OUT-1, OUT-4).
- Data sent to the vendor's hosted service by default even when docs suggest local storage.
- Self-hosted memory servers exposed without authentication (MCP-3).

**Add**
- Server-side tenant scoping from the session; provenance fields; purge-by-source; TTLs; secret scan before write (`secure-patterns.md` §6).

## Agent sandbox SDKs and runtimes
(E2B, Daytona, Modal, Vercel Sandbox, Cloudflare Sandbox, Docker sandboxes, microVM runtimes, Kubernetes agent sandboxes, Runloop, Blaxel, Northflank…)

**Help most (84%)**; Risk 11%.

**Traps**
- Egress open by default in several products; you must deny it (INJ-4).
- Long-lived or shared sandboxes reused across users (OUT-4 says per session, disposable).
- Secrets passed into the sandbox env "for convenience".
- Most leave alerting on abnormal behaviour to you (LOG-2).

**Add**
- One sandbox per session, destroyed after; non-root; no secrets; egress allowlist; resource limits; emit metrics.

## Low-code and visual agent builders
(Flowise, Langflow, Dify, n8n, Botpress, Zapier Agents, Copilot Studio, Agentforce…)

Help in 65% of cells, Risk in 13%.

**Traps**
- Self-hosted builders with long CVE histories and admin UIs on the internet (GW-2, MCP-3).
- Custom-code nodes that run in-process (OUT-4).
- Chat widgets that render markdown images from any domain (INJ-3). Six chat interfaces did this by default.

**Add**
- Keep the builder private (VPN/SSO), pinned and patched within days; staging copies count too.
- Route custom-code nodes to a sandbox; restrict image rendering in the chat widget.
