#!/usr/bin/env bash
# Phase 0 check for a Linux VM: what isolation and secret storage sapi can use on this machine.
#
# Safe to run: read-only, no sudo, installs nothing, makes no model calls. Outbound network is
# used only to confirm that sandboxed processes are cut off from it (one TCP attempt each).
#
#   bash scripts/phase0/linux-check.sh | tee phase0-linux.txt
#
# Then paste the output into docs/phase0-findings.md (section "Linux VM results").
set -uo pipefail

ok()   { printf '  [ok]   %s\n' "$*"; }
no()   { printf '  [no]   %s\n' "$*"; }
info() { printf '  [info] %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Returns 0 if a TCP connection to 1.1.1.1:443 succeeds from the given command prefix.
net_ok() { "$@" bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' >/dev/null 2>&1; }

echo "== Machine"
info "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") · kernel $(uname -r) · $(uname -m)"
[ -n "${SSH_CONNECTION:-}" ] && info "SSH session" || info "not an SSH session"
[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && info "no display (headless)" || info "display available"
[ "$(id -u)" = 0 ] && no "running as root (sapi refuses this)" || ok "not root"
net_ok env && ok "this shell can reach the internet" || no "this shell can't reach 1.1.1.1:443; network tests below are inconclusive"

echo "== systemd (user services)"
if have systemctl; then
  info "$(systemctl --version | head -1)"
  systemctl --user is-system-running >/dev/null 2>&1 && ok "user manager reachable" || no "user manager not reachable (systemctl --user)"
  linger=$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)
  [ "$linger" = yes ] && ok "lingering on (services keep running after logout)" || info "lingering: $linger (setup would run: loginctl enable-linger)"
else
  no "no systemd"
fi

echo "== User namespaces"
for f in /proc/sys/kernel/unprivileged_userns_clone /proc/sys/user/max_user_namespaces /proc/sys/kernel/apparmor_restrict_unprivileged_userns; do
  [ -r "$f" ] && info "$(basename "$f") = $(cat "$f")"
done
grep -qw landlock /sys/kernel/security/lsm 2>/dev/null && ok "Landlock enabled ($(cat /sys/kernel/security/lsm))" || info "Landlock not listed in /sys/kernel/security/lsm"

echo "== bubblewrap (planned Linux sandbox for the claude child)"
if have bwrap; then
  info "$(bwrap --version)"
  B=(bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-all --die-with-parent)
  if "${B[@]}" true 2>/dev/null; then
    ok "unprivileged bwrap works"
    net_ok "${B[@]}" && no "network still reachable inside --unshare-all (unexpected)" || ok "no network inside the sandbox"
    "${B[@]}" --tmpfs "$HOME" sh -c 'test -e "$HOME/.ssh"' 2>/dev/null && no "home still visible with --tmpfs \$HOME" || ok "home hidden with --tmpfs \$HOME"
  else
    no "bwrap can't create namespaces here: $("${B[@]}" true 2>&1 | head -1)"
    info "On Ubuntu 24.04 this is usually the AppArmor user-namespace restriction."
  fi
else
  no "bwrap not installed (apt install bubblewrap)"
fi

echo "== Transient user service sandboxing (fallback when bwrap is unavailable)"
if have systemd-run && systemctl --user is-system-running >/dev/null 2>&1; then
  R=(systemd-run --user --pipe --wait --quiet --collect)
  out=$("${R[@]}" -p PrivateUsers=yes -p ProtectSystem=strict -p ProtectHome=tmpfs -p PrivateTmp=yes \
        /bin/sh -c 'test -e "$HOME/.ssh" && echo HOME_VISIBLE || echo HOME_HIDDEN; touch /usr/.sapi-probe 2>/dev/null && echo USR_WRITABLE || echo USR_READONLY' 2>&1)
  info "PrivateUsers+ProtectSystem+ProtectHome: $(echo $out)"
  "${R[@]}" -p PrivateUsers=yes -p PrivateNetwork=yes bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' >/dev/null 2>&1 \
    && no "PrivateNetwork=yes did not cut the network" || ok "PrivateNetwork=yes cuts the network"
  "${R[@]}" -p IPAddressDeny=any bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' >/dev/null 2>&1 \
    && info "IPAddressDeny=any is NOT enforced in user units (expected: needs root)" || ok "IPAddressDeny=any enforced"
else
  no "systemd-run --user not usable"
fi

echo "== Secret storage options"
if have busctl && busctl --user status org.freedesktop.secrets >/dev/null 2>&1; then ok "Secret Service available"; else info "no Secret Service on the user bus (normal on headless VMs)"; fi
if have systemd-creds; then
  info "systemd-creds present"
  systemd-creds has-tpm2 >/dev/null 2>&1 && ok "TPM2 available for systemd-creds" || info "no TPM2: systemd-creds would use the host key only (needs root) or fall back to a 0600 file"
else
  no "systemd-creds not present"
fi

echo "== Claude CLI"
if have claude; then
  info "claude $(claude --version 2>/dev/null | head -1)"
  st=$(claude auth status --json 2>/dev/null | tr -d ' \n')
  case "$st" in *'"loggedIn":true'*) ok "signed in (default profile)";; *) info "not signed in (default profile)";; esac
else
  info "claude CLI not installed (sapi setup will offer the official installer)"
fi

echo "== Bun runtime for the compiled binary"
ldd --version 2>/dev/null | head -1 | sed 's/^/  [info] /'
echo
echo "Done. Nothing was changed on this machine."
