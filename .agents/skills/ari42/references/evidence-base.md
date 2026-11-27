# Evidence base

Where the 42 requirements come from and what the ARI-42 research measured. Use these numbers when
explaining to a user why a requirement matters. Do not inflate them.

## What ARI-42 is

ARI-42 (Agent Risk Index 42) rates widely used agent building blocks against 42 builder security
requirements. The requirements are an instrument consolidated from existing standards, not a new
standard: OWASP Top 10 for LLM Applications and for Agentic Applications (ASI), OWASP AISVS, the
OWASP GenAI 2026 papers, CSA AICM, AIUC-1, CoSAI (MCP security, agentic IAM, zero trust),
MITRE ATLAS, NIST AI RMF, ISO/IEC 42001, the EU AI Act, the MCP specification, and national
guidance (Five Eyes agentic guidance, IMDA, CERT-In, CNCERT, MAS, RBI, SEBI, NYDFS, FSB).

## The audit (edition 2026-11)

- **85 tools in 8 categories**: open-source frameworks, vendor SDKs and platforms, harness SDKs,
  MCP SDKs and gateways, skill tooling, memory layers, sandboxes, low-code builders.
- **2,099 applicable tool × requirement cells**, each rated Built in / Partial / Gap / Risk.
- **Every cell re-checked** against the tool's current version, mostly in disposable sandboxes,
  by observing defaults and reading shipped source. No exploits were run. 420 ratings changed.

| Rating | Share of applicable cells |
|---|---|
| Built in (met by default) | **3%** |
| Partial (off by default, needs config, or covers part) | 49% |
| Gap (builder does everything) | 34% |
| Risk (tool works against the requirement) | 15% |

**Where tools help:** an operational layer has converged: turn, spend and time limits (AUTH-4,
99% of tools help), run tracing (LOG-1, 88%), model pinning (GW-3, 88%), approvals (AUTH-3, 76%).

**Where they don't:** the requirements that bound what an attacker can do through an agent:
inventory of untrusted inputs (INJ-1, 9%), supply chain (GW-2, 10%), agent config protection
(SDLC-4, 19%), tool-description change detection (MCP-2, 23%), exposed-endpoint auth (MCP-3,
28%), never exceeding the user's permissions (AUTH-2, 31%), the lethal trifecta (INJ-2, 32%).

**Most common Risks after validation**

| Req | Risk in |
|---|---|
| GW-2 supply chain | 53 of 70 tools (76%) |
| MCP-3 unauthenticated exposed endpoints | 28 of 47 (60%) |
| OUT-4 unsandboxed generated code | 37 of 70 (53%); only 2 meet it by default |
| GW-1 provider keys reach agent commands | 22 of 69 (32%) |
| MCP-4 unsandboxed MCP servers | 23 of 79 (29%) |
| DATA-5 memory isolation | 17 of 64 (27%) |
| AUTH-2 exceeding the user's permissions | 17 of 65 (26%) |
| INJ-3 injection containment (e.g. markdown images) | 16 of 69 (23%) |

**Cross-tool patterns observed first-hand**
- Most coding harnesses pass the provider API key to commands the agent runs (dummy-key test).
- 6 of 8 official MCP SDKs tested start local servers with the client's full environment.
- 6 chat interfaces render markdown images from any domain by default.
- Many tools ship a ready-to-run server (agent server, dev console, MCP endpoint) with no auth.
- In at least 3 tools the documentation states a safer default than the code ships.
- 68 of 85 tools had at least one security incident or CVE in 2025–26.

**Validation lessons**
- Risk ratings drawn from advisories overstated current risk when projects had patched forward.
- Desk review understated help by missing first-party features, nearly all only Partial.
- So: check the installed version's actual default. Neither the CVE list nor the docs are enough.

## The CVE record

All **129,058** CVEs published in 2025–26 were screened. Under a broad definition **7,257 (5.6%)**
are in AI or agent software; the share rose from 3.0% (2025) to 7.0% (2026). 967 are critical.
Each was mapped to the one requirement that would most directly have prevented it.

| Req | AI CVEs | Share |
|---|---|---|
| OUT-4 sandbox agent-generated code | 1,302 | 17.9% |
| OUT-1 validate output before sinks | 1,131 | 15.6% |
| AUTH-2 never exceed the user's permissions | 1,108 | 15.3% |
| MCP-3 authenticate exposed MCP/agent APIs | 750 | 10.3% |
| INJ-4 deny-by-default egress | 636 | 8.8% |
| INJ-3 contain injection in code | 405 | 5.6% |
| MCP-4 sandbox MCP servers | 286 | 3.9% |
| DATA-5 isolate and purge memory | 214 | 2.9% |
| SDLC-3 review AI-written code | 214 | 2.9% |
| GW-2 agent stack as supply chain | 208 | 2.9% |
| GW-1 protect provider keys | 169 | 2.3% |
| SDLC-4 protect agent configuration | 129 | 1.8% |

- The top 5 requirements map to **68%** of AI CVEs; the top 10 to **86%**.
- **6,877 of 7,257 (94.8%)** map to at least one of the 42 requirements. The 380 that map to none
  are mostly memory-safety and denial-of-service bugs in ML libraries, where patching is the
  practical control.
- 31 of the 42 requirements map to at least one AI CVE. Governance, logging and evaluation items
  rarely appear because CVEs record code flaws, not missing process.

## Incidents

Of 759 AI incidents recorded in 2025–26, 89 were judged preventable by the builder. The
recurring pattern is an agent with write access deleting production data or files during routine
work. Every such case maps to AUTH-3 (approval), AUTH-1 (least privilege) and OUT-4/SDLC-2
(sandboxing). Others: agents acting without approval, data exposed through default credentials or
shared memory, and injection through outsider-writable records such as issue trackers.

## Honest limits

- The classifications were made with LLM assistance and validated observationally; a human
  inter-rater study is pending. Mapping CVEs to a single preventing requirement is a judgement.
- "Maps to a requirement" means the requirement, done properly, would most directly have
  prevented the flaw. It is not a guarantee that meeting the 42 stops every attack, and no
  checklist can promise that. Adaptive attacks broke 12 published prompt-injection defences, which
  is why this skill puts deterministic controls first.
