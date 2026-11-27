# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this
repository (GitHub Security Advisories). Please don't open a public issue, discussion or pull request
for a security problem.

Include what you found, how to reproduce it, the version or commit, and the impact you expect.

## What to expect

| Step | Target |
|---|---|
| Acknowledge your report | 3 working days |
| Confirm or decline, with reasoning | 10 working days |
| Fix released for a confirmed issue | depends on severity; critical issues are treated as urgent |
| Public advisory | when the fix is released, or 90 days after your report, whichever comes first |

We credit reporters in the advisory unless you ask us not to. We request a CVE for confirmed
vulnerabilities in released versions.

## Supported versions

sapi is pre-release (0.x). Only the latest release gets security fixes.

## Scope

In scope: the sapi gateway, its CLI, installer, release artifacts and CI configuration in this
repository. Especially:

- anything that lets a web page, another local user or another client reach the API, the dashboard
  or another client's data;
- anything that exposes provider credentials, client keys or request content;
- any way for request content to escape the Claude child process's confinement, add CLI flags or
  reach a host outside the egress allowlist;
- weaknesses in the release, signing or install path.

Out of scope: vulnerabilities in Anthropic's or OpenAI's own software or services (report those to
them), and attacks that need an already-compromised user account on the machine running sapi.

## How we build

The project follows the [ARI-42](ARI42.md) requirements for agent software. `ARI42.md` lists each
requirement, its status and its evidence. A threat model draft is in
[docs/threat-model.md](docs/threat-model.md).
