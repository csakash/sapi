# Setting up sapi on a Linux VM (and macOS)

The goal: a working gateway in a few minutes, with only the sign-ins left to you. Everything else
(checking the machine, installing the service, creating a key, testing, printing the two lines
your apps need) is done by `sapi setup`, and it is safe to run again.

> **Before the first release:** there are no published binaries yet, so `install.sh` has no
> download source. Until then, use [From source](#from-source-until-the-first-release).

## The four actions on a fresh VM

1. **Install.** One command. It picks the binary for your OS and CPU, checks its SHA-256 against
   the release's `SHA256SUMS` (and the signature, when cosign is installed and the release is
   signed), and installs to `~/.local/bin`. No root, no sudo.

   ```bash
   curl -fsSL <release URL>/install.sh | sh
   ```

   Prefer to read it first:

   ```bash
   curl -fsSLO <release URL>/install.sh && less install.sh && sh install.sh
   ```

2. **Run `sapi setup`.** It checks the machine (OS, CPU, SSH or desktop, container, WSL, systemd,
   the port, and refuses root), offers to install the tested `claude` CLI with Anthropic's
   official installer if it is missing, writes a config, and asks before anything that costs
   tokens or changes the system.

3. **Approve the Claude sign-in.** The real `claude` CLI takes over the terminal. On a VM it shows a
   link: open it on your laptop or phone, approve, and paste the code back. This signs in a separate
   Claude profile that only sapi uses; your own `claude` setup is untouched.

4. **Say yes to the rest.** A tiny test call (time to first token), your first client key (shown
   once), and the background service (a systemd user unit that keeps running after you log out).
   Setup ends with:

   ```text
   Done. sapi is listening on 127.0.0.1:8787
   Use it:
     export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
     export OPENAI_API_KEY=sk-sapi-…    # shown once: copy it now
   ```

ChatGPT sign-in joins step 3 in a later version.

## Checking and fixing

```bash
sapi doctor
```

Every check from setup plus the network path to Anthropic, the request-log hash chain, file
permissions, kill switches and key ages. Each problem comes with the command that fixes it.
`sapi doctor --json` gives the same as data.

```bash
sapi connect my-app
```

Copy-paste setup for curl, OpenAI Python and Node, LangChain and the Vercel AI SDK. Lost the key?
`sapi connect my-app --new-key` issues a new one (the old one stops working).

## Reaching the VM's sapi from your laptop

sapi listens on `127.0.0.1` only and refuses other addresses. Use an SSH tunnel:

```bash
ssh -N -L 8787:127.0.0.1:8787 you@your-vm
```

Then point apps on the laptop at `http://127.0.0.1:8787/v1`. Tailscale to the VM's loopback works
the same way.

## Unattended setup (cloud-init, Ansible, dotfiles)

Every prompt has a flag, and `--yes` takes the defaults. Write the key to a private file rather
than redirecting stdout: `--env-file` creates it with mode 600, and leaves it alone when setup runs
again and the client already exists.

```bash
sapi setup --yes --client my-app --env-file ~/.config/my-app/sapi.env --service
```

The Claude sign-in needs a person at a terminal (`sapi login claude`), so unattended setup lists it
under "Left for you" and still finishes. Advanced: with `--claude-auth env`, put a token from
`claude setup-token` in `~/.config/sapi/claude.env` (mode 600) yourself; sapi passes that one
variable to the `claude` process only and never reads it otherwise.

## Ubuntu 24.04: letting the sandbox start

sapi runs `claude` inside bubblewrap (`bwrap`). Ubuntu 24.04 restricts unprivileged user namespaces
through AppArmor by default, which stops bwrap. `sapi setup` and `sapi doctor` tell you when this
happens. The narrow fix allows user namespaces for bwrap alone:

```bash
sudo apt install bubblewrap
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
sapi doctor
```

If bwrap still can't start, sapi falls back to a transient systemd user service with
`PrivateUsers`, `PrivateNetwork`, `ProtectSystem=strict` and `ProtectHome=tmpfs`. With neither, the
Claude provider reports "not ready" rather than running unconfined (unless you set
`[claude] confinement = "best-effort"`, which `doctor` keeps warning about).

Turning the AppArmor restriction off for the whole machine
(`kernel.apparmor_restrict_unprivileged_userns=0`) also works; CI does that on throwaway runners,
but on a machine you keep, prefer the profile above.

## Lingering

The systemd user unit only keeps running after you log out when lingering is on. Setup turns it on
with `loginctl enable-linger`; if your system doesn't allow that without root, it tells you to run:

```bash
sudo loginctl enable-linger "$USER"
```

## Containers and WSL

- **WSL:** enable systemd in the distribution (`[boot] systemd=true` in `/etc/wsl.conf`, then
  `wsl --shutdown`), or run `sapi start --foreground` yourself.
- **Containers:** there is no service manager, so run `sapi start --foreground` as the container's
  process. The Claude subscription inside containers is not supported yet.

## macOS

The same `install.sh`, or Homebrew from the first release. `sapi setup` installs a launchd agent
(`~/Library/LaunchAgents/local.sapi.gateway.plist`) that starts at login; logs go to
`~/.local/share/sapi/logs/sapi.log`. The Claude sign-in opens your browser.

## Starting, stopping, removing

```bash
sapi stop                  # until the next boot or login
sapi start                 # the service if installed, otherwise this terminal
sapi uninstall             # removes the service and the binary, keeps config and data
sapi uninstall --purge     # also signs sapi's Claude profile out and deletes keys and logs
```

`--purge` asks before deleting, and only deletes folders that are recognisably sapi's.

## From source (until the first release)

```bash
git clone <repository URL> sapi && cd sapi
bun install --frozen-lockfile
bun src/cli.ts setup
```

The service then runs `bun src/cli.ts` from this checkout. To try `install.sh` itself, build a
local release and point the installer at it:

```bash
bun scripts/build-release.ts --targets linux-x64 --out /tmp/sapi-release
SAPI_DOWNLOAD_BASE=file:///tmp/sapi-release sh scripts/install.sh
```
