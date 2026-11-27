# sapi

A local, single-user gateway that lets any OpenAI- or Anthropic-compatible SDK use **your own** Claude
and ChatGPT subscriptions. Point your app's `base_url` at `http://127.0.0.1:8787/v1`, give it a sapi
key, and sapi routes the call to the right subscription, then shows which app used what and how
close you are to each limit.

> **Status: Phase 0 (foundations).** Nothing here is usable yet. The gateway lands in Phase 1.
> The build plan is in `docs/` once published; Phase 0 findings are in
> [docs/phase0-findings.md](docs/phase0-findings.md).

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

sapi is built to the [ARI-42](ARI42.md) agent-security requirements, checked in CI:

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
bun run check
```

## License

[Apache-2.0](LICENSE).
