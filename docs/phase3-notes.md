# Phase 3 notes: ChatGPT and the other entry points

Date: 2026-11-28. Branch: `phase-3-chatgpt`.

## Built

| Area | Files | Tests |
|---|---|---|
| Secret store: Keychain or Secret Service (Bun.secrets, in-process), `systemd-creds --user` over stdin, 0600 file; `auto` records its first choice | `src/secrets.ts` | `test/unit/secrets.test.ts` |
| Sign in with ChatGPT: PKCE (S256), registration with `dynamic_agent_client` then the issued `oaiapp_…` ID, per-host `ext_agent_host_id`, loopback callback, scope check, ID-token verification (RS256, issuer, audience, expiry, nonce), revocation | `src/providers/chatgpt-sub/oauth.ts`, `login.ts` | `test/unit/chatgpt-oauth.test.ts` |
| Headless sign-in: `--ssh` prints the tunnel; `--export` / `--import` move a sign-in to a VM, keeping the VM's host ID | `src/providers/chatgpt-sub/login.ts`, `cli.ts` | `test/unit/chatgpt-oauth.test.ts` |
| Tokens: refresh before expiry and once after a 401, serialised, store re-read first, cleared only on terminal errors | `src/providers/chatgpt-sub/session.ts` | `test/unit/chatgpt-adapter.test.ts` |
| ChatGPT adapter: Responses API with `store: false` and `stream: true`, Zod-parsed events, usage, error mapping, usage-limit pause | `src/providers/chatgpt-sub/adapter.ts`, `sse.ts`, `manifest.ts` | `test/unit/chatgpt-adapter.test.ts`, `test/security/chatgpt.test.ts` |
| sapi's own egress: https to the manifest's hosts only, through a dedicated proxy, redirects refused | `src/egress-fetch.ts`, `src/start.ts` | `test/security/chatgpt.test.ts` |
| Doors: one interface; `POST /v1/responses` (OpenAI Responses, stateless) and `POST /v1/messages` (Anthropic Messages); errors in each caller's format | `src/doors/types.ts`, `common.ts`, `responses.ts`, `messages.ts`, `chat.ts`, `src/gateway.ts`, `src/server.ts` | `test/unit/doors.test.ts`, `test/security/auth-everywhere.test.ts`, `test/contract/doors.test.ts` |
| Routing: `auto` across Claude and ChatGPT; per-provider timeouts and concurrency (`[chatgpt]`) | `src/gateway.ts`, `src/config.ts` | `test/unit/chatgpt-wiring.test.ts` |
| Commands: `sapi login chatgpt [--ssh] [--port] [--export] [--import] [--register]`, `sapi logout chatgpt`; ChatGPT in `status`, `doctor`, `setup` (writes `gpt` and `auto`) and `uninstall --purge` | `src/cli.ts`, `src/providers/chatgpt-sub/cli.ts`, `src/setup/` | `test/unit/chatgpt-wiring.test.ts` |
| Contract tests: openai-node Responses, `@anthropic-ai/sdk` Messages and openai-python Responses, each against the fake provider and against ChatGPT on a fake OpenAI | `test/contract/doors.test.ts`, `test/fixtures/fake-openai.ts` | — |

## Verified here (macOS 26.2)

- `bun run ci`: all 10 checks (numbers in the change summary).
- The egress path for real: Bun's fetch through sapi's proxy reached `auth.openai.com`, and the
  discovery document matched the protocol as implemented: issuer `https://auth.openai.com`, the
  authorize, token and revocation endpoints, `jwks_uri` on the same origin, RS256 keys, PKCE
  S256. A host off the list was refused.
- All three doors with real SDKs (openai-node, the Anthropic SDK, openai-python), streamed and
  not, against both the fake provider and the ChatGPT adapter on a fake OpenAI.
- **A real Sign in with ChatGPT, from source** (`bun src/cli.ts login chatgpt`, desktop): the
  first sign-in registered sapi (the callback carried the issued `oaiapp_…` client ID), the code
  exchange returned every documented field, both required scopes were granted, the ID token
  verified (RS256 against the published keys, issuer, audience, expiry, nonce), and the sign-in
  went into the macOS Keychain (`os` backend, recorded). The plan listed three models.
- **Real calls** (`bun scripts/e2e/real-chatgpt.ts`, a throwaway gateway; config and request log
  untouched): 8 of 8 passed on `gpt-6-luna`: Chat Completions streamed and not (first token
  1.25 s), a multi-turn chat with a system prompt, the ignored-params header, Responses streamed
  and not, and the Anthropic SDK on `/v1/messages` streamed and not. About 1–2 s per call.
- **A real token refresh** (forced): new access token, the refresh token rotated and saved to the
  Keychain, scopes and client ID kept.
- **Through the background service**: with `gpt` and `auto` added to the config and the launchd
  agent restarted, `sapi doctor` passed every check (ChatGPT signed in, `api.openai.com`
  reachable), and real calls through the agent worked: `gpt` on Chat Completions and on
  `/v1/messages`, and `auto` (routed to `sonnet`, under its window). So the login agent reads the
  Keychain item a terminal sign-in wrote. The service log holds only start-up lines.

## Not verified yet

- **Sign-out at OpenAI** (`sapi logout chatgpt` revoking the refresh token): not run, to keep the
  sign-in. The revocation endpoint is the one the discovery document names.
- **A usage-limit answer** from OpenAI; the pause logic is tested against a fake only.
- **The SSH tunnel and export/import paths** with a real account and a real VM.
- **The Keychain item after a Bun or sapi upgrade** (macOS may ask before a different binary
  reads it, which a background service can't answer).
- **`systemd-creds --user` and Secret Service on Linux.** Recorder tests only; Ubuntu 24.04 ships
  systemd 255, so a headless 24.04 VM falls back to the 0600 file.

## Decisions and changes from the plan

- **Bun.secrets for the OS store.** One in-process implementation covers the macOS Keychain and
  Linux Secret Service, so a secret never goes through argv (the `security` command would put it
  there) or a pipe. Items are created without "unrestricted access".
- **The backend is recorded at the first write**, so a terminal and the background service can't
  end up looking in different stores.
- **No silent fallback between stores**: a recorded store that can't be reached is an error.
- **`--export` keeps nothing on the laptop**, so a sign-in is only ever refreshed in one place
  (refresh tokens rotate; two refreshers would break each other).
- **Tool calling stays in Phase 5** for every door and provider, though ChatGPT supports tools
  natively: one design for imitated (Claude) and native (ChatGPT) tools.
- **`response.incomplete`** ends a call with finish `length`, and the Responses door ends such a
  stream with `response.incomplete`, as OpenAI does.
- **`max_tokens` on `/v1/messages`** is listed as ignored but never refused by `strict_params`:
  the Messages API requires it, so every Anthropic client sends it.
- **Usage limit**: a 15-minute pause instead of a guessed reset time (OpenAI says not to infer
  one); the window shows as 100%, estimated.
- **ChatGPT model IDs come from the plan**, not from sapi's defaults: setup writes the first model
  the plan lists as `gpt`, and `auto = ["sonnet", "gpt"]` when both providers are set up. An
  existing config is never edited; sapi prints the line to add.
- **No `codex exec` fallback.** The plan kept it for accounts that can't use Sign in with ChatGPT;
  it isn't needed until such an account turns up.
