# Threat model (draft)

**Status:** draft for ARI-42 GOV-2, written 2026-11-27 in Phase 0. A maintainer must review and sign
it before 0.1. It describes the design in the build plan; the code arrives from Phase 1.

## What sapi protects

| Asset | Where it lives |
|---|---|
| Access to the user's Claude subscription | inside the `claude` CLI's own profile for sapi; sapi never reads it |
| ChatGPT OAuth tokens | OS secret store (Keychain, Secret Service or `systemd-creds`) |
| Direct API keys (0.2+) | OS secret store, referenced from config |
| Client keys | only SHA-256 hashes in SQLite; shown once at creation |
| Admin session | OS secret store; cookie after login |
| Request content | in memory only, unless the user turns on `log_bodies` |
| Usage history | SQLite, metadata only, hash-chained |

## Who might attack, and what they try

| Attacker or failure | What they try | Main controls |
|---|---|---|
| A web page in the user's browser | DNS rebinding or a cross-site request to `127.0.0.1:8787` | Host allowlist, Origin check, no CORS, client keys, SameSite=Strict cookies, CSRF tokens on admin actions |
| Another local user or process | Call the API, read secrets or logs | Client keys, admin token, `0600` files, `umask 077`, encrypted secrets, optional Unix socket |
| A client app with a valid key | Exceed its share, read other clients' data, inject CLI flags, forge conversation turns | Scopes, budgets, rate limits, per-client isolation, model names only from config, argv-only spawning, escaped transcript tags |
| Hostile prompt content | Hijack the Claude child to act or leak data | No tools, no MCP, empty environment and working directory, egress allowlist, OS sandbox. The model can be fully hijacked and still has nothing to act with |
| Request data shown on the dashboard | Stored XSS through client names, user agents or errors | Text-only rendering, strict CSP |
| A compromised dependency or release | Ship malicious code to users | Few dependencies, hashed lockfile, minimum package age, SHA-pinned CI, signed releases with provenance and an SBOM |
| A stolen laptop or VM disk | Read tokens and keys | OS secret store or machine-bound encryption; key hashes only; no request bodies by default |
| A runaway client | Use up the subscription window | Budgets that halt, per-client window caps, kill switches, alerts |
| Provider-side changes | CLI flags or output change, terms tighten | Tested CLI version range, replay tests on recorded fixtures, `sapi doctor` warnings, terms re-checked each release |

## Trust boundaries

1. **Network → sapi:** only loopback by default. Everything that arrives is untrusted, even from
   localhost.
2. **sapi → Claude child process:** the child gets the prompt and nothing else (no secrets, no files,
   no tools). Its only network route is sapi's egress proxy.
3. **sapi → providers:** outbound only to hosts listed in each provider's manifest, after checking
   that the address isn't private, link-local or a metadata service.
4. **sapi → dashboard browser:** request-derived text is data, rendered as text.

## Worst cases and what stops them

| Worst case | Stopped by |
|---|---|
| A website drives the user's subscription | Host and Origin checks, plus a key it doesn't have |
| Prompt content makes the Claude child read `~/.ssh` and send it out | No tools; the sandbox denies the read; the egress proxy denies the host |
| A client turns a model name into `--dangerously-…` | Model names must match configured aliases; spawning uses argv arrays |
| A leaked client key | Scoped to that client, rate-limited, budgeted, revocable instantly; fingerprint-change alert |
| sapi exposed on a network by mistake | Non-loopback refused without TLS and an explicit flag; dashboard never leaves loopback |

## Residual risks

- Anthropic's terms don't explicitly cover a local gateway around `claude -p`; sapi stays as close as
  it can (single user, unmodified binary, isolated profile).
- On machines without systemd (some containers, WSL) or with sandboxing unavailable, the Claude child
  runs with fewer OS layers. The other controls still apply, and `sapi doctor` reports it.
- A malicious local process running as the same user can read the user's files anyway; sapi doesn't
  try to defend against a compromised user account.
