# ARI-42 record: <project name>

Security record for the AI and agent parts of this project, kept by the coding agent under the
ARI-42 skill and reviewed by people. Update it in the same change as the code.

- **Last reviewed:** YYYY-MM-DD
- **Owner for AI security:** <name>
- **Score:** <met> of <in-scope> in-scope requirements met with evidence · <risk> Risk · <gap> Gap

## AI-BOM (GOV-1)

Generated with `python3 <skill-dir>/scripts/ari42_scan.py detect . --json`, then checked by hand.

| Component | Kind | Version / pin | Where | Data it can reach | Owner |
|---|---|---|---|---|---|
| e.g. claude-sonnet-5-5 | model | dated ID | `src/agent/config.py` | support tickets (redacted) | |
| e.g. @modelcontextprotocol/sdk | MCP SDK | 1.x.y (lockfile) | `src/mcp/` | — | |

## Agent register (GOV-4)

| Agent | Tools (read / write / consequential) | Autonomy | Approval required for | Accountable owner |
|---|---|---|---|---|
| | | suggest / act with approval / act alone | | |

## Trust boundaries (INJ-1, INJ-2)

| Agent | Untrusted inputs (who can write them) | Private data | Exfiltration paths | Control that breaks the trifecta |
|---|---|---|---|---|
| | | | | |

## Data flow (DATA-1)

| Feature | Data sent | Redaction | Provider / region | Stored in (logs, memory, vendor) |
|---|---|---|---|---|

## Status of the 42

Status: **Met** (enforced + passing check) · **Partial** · **Gap** · **Risk** · **N/A** (reason) ·
**Human** (owned by a person) · **Exception** (accepted risk).

CI runs `ari42_scan.py verify`, which passes only when every row not marked N/A is Met or an
accepted exception. Keep all 42 rows. For Met, cite evidence that exists, as a path in backticks:
a test, eval or CI file for build-time requirements, or a dated (YYYY-MM-DD) record for the
periodic ones (GOV-2, GOV-3, GOV-4, INJ-1, LOG-3, EVAL-2, SDLC-1). A detected requirement can be
marked N/A only with a row in Exceptions, accepted by a person.

| ID | Requirement | Status | Evidence / reason |
|---|---|---|---|
| GOV-1 | Maintain an AI bill of materials | | |
| GOV-2 | AI policy and risk assessment | Human | |
| GOV-3 | Notify customers of AI changes | Human | |
| GOV-4 | Define agent autonomy and owner | | |
| DATA-1 | Map data reaching models | | |
| DATA-2 | Minimise data sent to models | | |
| DATA-3 | No provider training; bounded retention | | |
| DATA-4 | Control inference location | | |
| DATA-5 | Isolate and purge agent memory | | |
| AUTH-1 | Per-agent identity | | |
| AUTH-2 | Never exceed the user's permissions | | |
| AUTH-3 | Approval for consequential actions | | |
| AUTH-4 | Kill switch and hard limits | | |
| INJ-1 | Inventory untrusted inputs | | |
| INJ-2 | Break the lethal trifecta | | |
| INJ-3 | Contain injection in code | | |
| INJ-4 | Deny-by-default egress | | |
| INJ-5 | No secrets in prompts | | |
| OUT-1 | Validate model output before sinks | | |
| OUT-2 | Disclose AI; guard user-facing output | | |
| OUT-3 | People in decisions about people | | |
| OUT-4 | Sandbox agent-generated code | | |
| MCP-1 | Allowlist and pin servers and skills | | |
| MCP-2 | Detect tool-description changes | | |
| MCP-3 | Authenticate exposed MCP/agent APIs | | |
| MCP-4 | Sandbox MCP servers | | |
| GW-1 | Protect provider keys | | |
| GW-2 | Agent stack as critical supply chain | | |
| GW-3 | Pin models; evaluate before switching | | |
| LOG-1 | Log every agent run | | |
| LOG-2 | Detect abnormal agent behaviour | | |
| LOG-3 | Plan for AI incidents | Human | |
| LOG-4 | Customer access to agent records | | |
| EVAL-1 | Gate releases on security evals | | |
| EVAL-2 | Independent adversarial testing | Human | |
| EVAL-3 | Version prompts and config as code | | |
| SDLC-1 | Approve coding assistants | Human | |
| SDLC-2 | Sandbox coding agents | | |
| SDLC-3 | Review AI-written code | | |
| SDLC-4 | Protect agent configuration | | |
| SDLC-5 | Isolate CI agents | | |
| SDLC-6 | Block hallucinated packages | | |

## Exceptions

| ID | What is not met | Why accepted | Accepted by | Review by |
|---|---|---|---|---|

## Needs a human

- [ ] GOV-2 sign the risk assessment for <feature>
- [ ] …

## Change log

| Date | Change | Requirements touched | Status after |
|---|---|---|---|
