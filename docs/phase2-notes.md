# Phase 2 notes: setup and onboarding

Date: 2026-11-27. Branch: `phase-2-setup`.

## Built

| Area | Files | Tests |
|---|---|---|
| `sapi setup`, guided or `--yes`: machine checks (refuses root), Claude CLI found or installed, sign-in hand-off, config written once, a self-test through HTTP, the first key, the background service | `src/setup/setup.ts` | `test/security/setup.test.ts` |
| Machine detection: OS, CPU, SSH or desktop, container, WSL, systemd user manager or launchd, lingering, port state | `src/setup/machine.ts` | `test/unit/setup.test.ts` |
| Background service: launchd agent (`local.sapi.gateway`) and systemd user unit (`sapi.service`) with lingering; `sapi service install\|uninstall\|status`, `sapi start` and `stop` drive it | `src/setup/service.ts` | `test/unit/setup.test.ts` |
| `sapi doctor` (`--json`, `--offline`): files and permissions, log chain, keys and key age, kill switches, service and port, sandbox, Claude version and sign-in, network to Anthropic, PATH; a fix for each problem | `src/setup/doctor.ts` | `test/security/setup.test.ts`, `test/unit/cli.test.ts` |
| `sapi connect <client>`: curl, OpenAI Python and Node, LangChain, Vercel AI SDK; `--new-key` | `src/setup/connect.ts` | `test/unit/setup.test.ts`, `test/unit/cli.test.ts` |
| `sapi uninstall [--purge]`: service and binary; `--purge` signs sapi's Claude profile out, then deletes only folders that are recognisably sapi's | `src/setup/uninstall.ts` | `test/security/setup.test.ts` |
| Claude CLI install: Anthropic's installer, redirects followed only to Anthropic's hosts, shape-checked, run with bash from argv with the tested version and a minimal environment | `src/setup/claude.ts` | `test/unit/setup.test.ts` |
| `scripts/install.sh`: OS and CPU detection, SHA-256 against `SHA256SUMS`, cosign signature when available (`SAPI_REQUIRE_SIGNATURE=1` to insist), `~/.local/bin`, no root | `scripts/install.sh`, `scripts/build-release.ts` | `test/security/install-script.test.ts` |
| VM guide | `docs/vm-setup.md` | — |

## Verified here (macOS 26.2)

- The full suite, lint, types and the ARI-42 scan (numbers in the change summary).
- The compiled binary end to end in a temporary folder: `install.sh` from a local release
  (checksum verified) → `sapi setup --yes --providers fake --env-file … --no-service` → `doctor`
  → `connect` → `uninstall --purge --yes`.
- `sapi doctor` against the real, signed-in sapi profile: Claude ready through the same
  keychain-linked `HOME` a request uses, `api.anthropic.com:443` reachable.
- **The launchd agent, for real, from source** (`bun src/cli.ts setup --yes --client my-app
  --env-file ~/.config/sapi/my-app.env`): config written, self-test 1.2 s to first token (Haiku),
  key written with mode 600, agent loaded in `gui/<uid>` and answering. Through the agent: a
  non-streamed and a streamed Haiku call with the client key (so the keychain sign-in works from a
  login agent, not only from a terminal), 401 without a key. `sapi stop` / `service status` /
  `sapi start` behave; after `kill -9` launchd brought the gateway back in about 10 s
  (`KeepAlive`, `ThrottleInterval` 10). Running setup again kept the config, the key and the env
  file, and reloaded the agent. `sapi doctor` passes every check; the service log holds only the
  start-up lines. The plist (0644) holds paths only.

## Not verified yet

- **The systemd user unit on a real VM.** The commands are unit-tested with a recorder; it needs
  a run on a Linux VM, following `docs/vm-setup.md`.
- **The launchd agent from the compiled binary** (from source it runs `bun src/cli.ts`; the
  compiled binary's agent is the same plist with one program argument fewer).
- **Anthropic's installer** has not been run by sapi (claude is already installed here). Its
  download, redirect and shape checks are tested with fakes.
- **Guided (interactive) setup** with a person at the prompts; `--yes` is what the tests drive.
- **The Ubuntu 24.04 AppArmor profile** in `docs/vm-setup.md` is the standard per-program pattern
  and still needs a run on the VM (with `scripts/phase0/linux-check.sh`).

## Decisions and changes from the plan

- **`--env-file` alongside `--print-env`.** Redirecting `--print-env > file` creates the file with
  the shell's umask (often 0644) and empties it if setup runs again without a new key.
  `--env-file` writes it with mode 600 and leaves it alone on re-runs. The key never goes to the
  progress log when it went to a file or stdout, so it stays out of CI logs.
- **Self-test client.** The test call uses a reserved client, `sapi-selftest`, with a fresh key per
  run that is disabled afterwards; it shows up honestly in the request log. Names starting with
  `sapi-` are reserved.
- **Config is written once.** Setup never edits an existing config; a Claude-only config leaves
  `[models]` to sapi's defaults so they keep up with releases.
- **The one shell script sapi runs** is Anthropic's installer, after the user says yes, saved to a
  private file and shown by hash. Everything else is argv only.
- **`sapi start`** starts the installed service; `--foreground` runs in the terminal (and is what
  the service itself runs).
- **No release source yet.** `install.sh` refuses to guess a download URL until `REPO` is set
  (with the CODEOWNERS handle, before the first release).
- **No install workflow in GitHub Actions**, at the owner's request. The plan's "e2e workflow on
  a fresh Ubuntu runner" became a by-hand run: done on macOS (above), still to do on a Linux VM.
- **ChatGPT sign-in** moves with the ChatGPT adapter to Phase 3. **Dashboard access** (one-time
  code, admin token) moves to Phase 4 with the dashboard.
