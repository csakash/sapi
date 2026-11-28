# Provider: ChatGPT subscription (`chatgpt-sub`)

sapi uses your ChatGPT plan through **Sign in with ChatGPT**, OpenAI's sign-in for local and
open-source tools (developers.openai.com/siwc). Unlike the Claude provider there is no child
process: sapi signs in with OAuth and calls OpenAI's Responses API itself.

Code: `src/providers/chatgpt-sub/` (`oauth.ts` sign-in protocol, `login.ts` the commands,
`session.ts` tokens and refresh, `adapter.ts` the API calls, `sse.ts` the stream reader).
Secret storage: `src/secrets.ts`. Outbound calls: `src/egress-fetch.ts`.

## Data flow (ARI-42 DATA-1)

| Step | What | Where it goes |
|---|---|---|
| Request | the caller's messages, the system prompt as `instructions`, the pinned model ID from config | `POST https://api.openai.com/v1/responses` with `store: false` and `stream: true` |
| Not sent | the caller's sapi key and headers, `user`, `metadata`, `temperature`, `top_p`, `max_output_tokens`, `previous_response_id`, any tool | dropped at the door and listed in `x-sapi-ignored-params`, or refused with a 400 |
| Auth | `Authorization: Bearer <ChatGPT access token>`, `user-agent: sapi/<version>` | `api.openai.com` only |
| Answer | text deltas and usage from the event stream; only `response.completed` (or `response.incomplete`) ends a call successfully | the caller, in its own API format |
| Kept by sapi | one metadata row per request (no bodies), as for every provider | sapi's SQLite |
| Kept by OpenAI | nothing from the request itself (`store: false`); the plan's own data controls apply | OpenAI |

`test/security/chatgpt.test.ts` pins this down through all three doors.

## Signing in

`sapi login chatgpt` runs OAuth with PKCE (S256) and no client secret:

1. A host ID (`ext_agent_host_id`, `urn:uuid:…`, not a secret) is created once and kept in
   `~/.local/share/sapi/chatgpt-host.json` (0600).
2. A one-shot listener starts on `http://127.0.0.1:<free port>/auth/callback`. It answers only on
   127.0.0.1 with the right Host and path, checks `state` in constant time, accepts one callback,
   and shows a fixed page that echoes nothing.
3. The browser opens `https://auth.openai.com/api/accounts/authorize`. The first sign-in registers
   sapi (`client_id=dynamic_agent_client`, `agent_name_hint=sapi`); the callback returns the
   issued `oaiapp_…` client ID, which sapi saves and uses from then on.
4. The code is exchanged at `https://auth.openai.com/api/accounts/oauth/token`. sapi checks the
   granted scopes (`chatgpt.tokens.use.direct` and `offline_access` are required; the user can
   decline them) and verifies the ID token: RS256 signature against OpenAI's published keys, then
   issuer, audience (the issued client ID), expiry and the nonce sent with this sign-in.
5. The tokens go into the secret store, and sapi lists the models the plan offers
   (`GET /v1/models`, entries with `visibility: "list"`).

Endpoints, the issuer, the key set and RS256 were checked against OpenAI's discovery document
(`https://auth.openai.com/.well-known/openid-configuration`) on 2026-11-28.

### On a machine without a browser

There is no device-code flow for third-party tools. Two ways:

- **SSH tunnel** (`sapi login chatgpt --ssh`, also chosen automatically in an SSH session with no
  display). sapi prints `ssh -N -L <port>:127.0.0.1:<port> you@vm` and the sign-in link; run the
  command on your laptop, open the link there, and the browser's redirect reaches the VM through
  the tunnel.
- **Sign in on the laptop, move it over** (OpenAI's own documented path):
  `sapi login chatgpt --export - | ssh you@vm sapi login chatgpt --import -`. The export isn't kept
  on the laptop, so only the VM ever refreshes it; the VM keeps its own host ID. A file works too
  (`--export FILE` writes a new 0600 file; `--import FILE` deletes it after importing).

## Tokens and refresh

- Access tokens last an hour; sapi refreshes two minutes before expiry, or once after a 401.
- Refresh tokens last 30 days and are replaced on every refresh, so a sign-in in regular use never
  lapses. `sapi doctor` warns three days before an idle one does.
- Only the gateway refreshes. Refreshes are serialised, and the store is re-read first, so a newer
  `sapi login chatgpt` is never overwritten with an older token.
- A refresh token OpenAI calls unusable (`invalid_grant`, `refresh_token_reused`, …) clears the
  sign-in; a network or server failure never does.
- `sapi logout chatgpt` revokes the refresh token at the endpoint named in the discovery document,
  then deletes the sign-in. If OpenAI doesn't confirm, sapi still deletes it and says so.
  `sapi uninstall --purge` does the same.

## Secret store (ARI-42 GW-1)

`[secrets] backend` in `config.toml`: `auto` (default), `os`, `systemd-creds` or `file`.

| Backend | Where | How the secret moves |
|---|---|---|
| `os` | macOS Keychain or Linux Secret Service (service `local.sapi`) | in-process through Bun.secrets: never argv, a pipe or a file |
| `systemd-creds` | `~/.config/sapi/secrets/*.cred`, encrypted with `systemd-creds --user` (systemd 256+) | plaintext over stdin and stdout only, with a fixed minimal environment |
| `file` | `~/.config/sapi/secrets/*.secret`, 0600 in a 0700 folder | written to a new file, then renamed over the old one |

`auto` takes the first that works (on Linux the OS store needs a session bus and a keyring) and
records the choice at the first write (`~/.local/share/sapi/secrets-backend`), so the background
service reads the store a terminal sign-in wrote, even if it could see a different one. A recorded
store that isn't reachable is an error with a fix, never a silent switch. The Claude child's
sandbox can't read `~/.config/sapi`.

On macOS the Keychain item belongs to the program that wrote it. If a later sapi or Bun binary
can't read it without asking, sign in again with `sapi login chatgpt`.

## Network (ARI-42 INJ-4)

sapi's own calls go through a second egress proxy that allows only `api.openai.com` and
`auth.openai.com` (the Claude child's proxy allows neither). Every call is https on port 443 to a
host on that list, with redirects refused; URLs from the discovery document are used only if they
stay on `auth.openai.com`.

## Limits

The API reports no usage windows. On Plus the five-hour limit is shared with your other ChatGPT
apps; Pro has none. When OpenAI answers `subscription_sharing_usage_limit_exceeded` (before or
during a stream), sapi pauses ChatGPT for 15 minutes rather than guessing a reset time, reports
the window as 100% (estimated), and `auto` routes elsewhere. Usage: https://chatgpt.com/settings/usage

## Errors

| OpenAI | sapi | Notes |
|---|---|---|
| 401, `subscription_sharing_invalid_user` | `provider_not_ready` 503 | after one refresh and retry |
| 403 `subscription_sharing_user_not_eligible` | `provider_not_ready` 503 | not retried |
| 403 `chatpass_v2_*` | `provider_not_ready` 503 | sign in again and allow plan usage |
| other 403 | `upstream_error` 502 | policy or permission check |
| 400 `subscription_sharing_unsupported_capability`, other 400 | `bad_request` 400 | usually a model the plan doesn't offer |
| 429 usage limit | `provider_window_exhausted` 429 | pauses ChatGPT |
| other 429 | `provider_window_exhausted` 429 | `Retry-After` passed on |
| 503 | `provider_not_ready` 503 | retried twice before any output |
| `response.failed` | `upstream_error` 502 | or the usage limit, as above |

Messages are fixed strings; OpenAI's own error text is never passed through.

## Measured on a real plan (2026-11-28)

A desktop sign-in from source registered sapi and stored the sign-in in the Keychain; the plan
listed three models. `bun scripts/e2e/real-chatgpt.ts` passed 8 of 8 calls on `gpt-6-luna`
through all three doors (about 1–2 s per call, first token 1.25 s), and a forced refresh rotated
the refresh token. The launchd agent read the same Keychain item and served `gpt` and `auto`.
Sign-out at OpenAI, a real usage limit, and the VM paths are still untested;
see `docs/phase3-notes.md`.
