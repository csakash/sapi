# sapi

A local, single-user gateway that lets any OpenAI- or Anthropic-compatible SDK use **your own** Claude
and ChatGPT subscriptions. Point your app's `base_url` at `http://127.0.0.1:8787/v1`, give it a sapi
key, and sapi routes the call to the right subscription, then shows which app used what and how
close you are to each limit.

> **Status: Phase 3 (ChatGPT and the other entry points).** Text chat through your Claude
> subscription works on macOS, with guided setup, a background service, `doctor`, `connect` and
> `uninstall`. ChatGPT works too (Sign in with ChatGPT, checked against a real plan), and so do the
> OpenAI Responses and Anthropic Messages endpoints. There are no published binaries yet, and the
> dashboard comes later. Notes:
> [Phase 0](docs/phase0-findings.md), [Phase 1](docs/phase1-notes.md),
> [Phase 2](docs/phase2-notes.md), [Phase 3](docs/phase3-notes.md).

## Try it from source

```bash
bun install --frozen-lockfile
bun src/cli.ts setup     # checks, Claude sign-in, a test call, your first key, the background service
bun src/cli.ts setup --providers claude-sub,chatgpt-sub   # the same, plus Sign in with ChatGPT
```

Setup ends with the two lines your apps need:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=sk-sapi-…      # shown once
```

Then `sapi doctor` checks everything (each problem with its fix), and `sapi connect my-app` prints
copy-paste setup for curl, OpenAI Python and Node, LangChain and the Vercel AI SDK. Models are
aliases from the config (`haiku`, `sonnet`, `opus` by default; `gpt` and `auto` once ChatGPT is
set up). Besides `/v1/chat/completions`, sapi serves `/v1/responses` (OpenAI Responses, stateless)
and `/v1/messages` (Anthropic Messages: point the Anthropic SDK's `baseURL` at
`http://127.0.0.1:8787`). On a Linux VM, see [docs/vm-setup.md](docs/vm-setup.md); ChatGPT
sign-in there goes through an SSH tunnel or a sign-in moved from your laptop
([docs/providers/chatgpt-sub.md](docs/providers/chatgpt-sub.md)).

To check the whole path against your subscription (about eight tiny Haiku calls through
openai-node, and openai-python and LangChain if installed):

```bash
bun src/cli.ts clients add e2e --print-env > e2e.env && chmod 600 e2e.env
set -a; . ./e2e.env; set +a; bun scripts/e2e/real-claude.ts
```

And for ChatGPT, after `bun src/cli.ts login chatgpt` (eight tiny calls through all three
endpoints, in a throwaway gateway that leaves your config and logs alone):

```bash
bun scripts/e2e/real-chatgpt.ts
```

sapi is not affiliated with Anthropic or OpenAI. Their names describe compatibility only.

## What it will do

- **Drop-in for SDKs and tools:** OpenAI Chat Completions, OpenAI Responses and Anthropic Messages
  endpoints, so openai-python, openai-node, the Anthropic SDK, LangChain, the Vercel AI SDK, Cursor,
  n8n and curl work by changing two settings.
- **Your subscriptions as backends:** Claude through the official, unmodified `claude` CLI in a
  sandboxed child process; ChatGPT through Sign in with ChatGPT. Direct API providers come later.
- **A dashboard** for usage per app, each subscription's limit windows with a burn-rate projection,
  errors, budgets and kill switches.
- **Four actions to set up** on a laptop or a headless Linux VM: install, `sapi setup`, approve the
  Claude sign-in, approve the ChatGPT sign-in.

## Rules sapi follows, and so must you

- **One person, their own subscriptions.** sapi is for your own use on your own machine. Don't share
  it, host it for others, or put other people's traffic through your subscription. Anthropic's terms
  forbid routing requests through subscription credentials on behalf of other users.
- **sapi never reads, stores or forwards your Claude login.** Sign-in happens inside the official
  `claude` CLI, in a profile only sapi uses.
- **Anthropic's terms don't mention local gateways like this one.** sapi is designed to stay as close
  to them as possible: single user, unmodified binary, ordinary use. Read the provider terms yourself
  and decide.

## Security

sapi is built to the [ARI-42](ARI42.md) agent-security requirements, checked by `bun run ci`:

- Listens on `127.0.0.1` only, requires a key for every client, and rejects requests from web pages.
- No telemetry. sapi never phones home.
- The Claude child process gets a scrubbed environment, an empty working directory, no tools and no
  MCP servers, and can reach only an allowlist of provider hosts through sapi's egress proxy.

To report a vulnerability, see [SECURITY.md](SECURITY.md). Please don't open a public issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Development needs [Bun](https://bun.sh) 1.3.14 or the dev
container in `.devcontainer/`.

```bash
bun install --frozen-lockfile
bun run ci
```

## License

[Apache-2.0](LICENSE).
