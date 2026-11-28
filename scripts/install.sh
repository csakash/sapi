#!/bin/sh
# sapi installer (plan §5, ARI-42 GW-2).
#
#   curl -fsSL <release URL>/install.sh | sh
#
# Prefer to read it first?  curl -fsSLO <release URL>/install.sh; less install.sh; sh install.sh
#
# What it does, and nothing else:
#   1. picks the release binary for this OS and CPU (macOS or Linux, x64 or arm64)
#   2. downloads it and SHA256SUMS into a private temporary folder
#   3. checks the binary's SHA-256 against SHA256SUMS; on any mismatch it stops and installs nothing
#   4. checks the cosign signature of SHA256SUMS when the release has one and cosign is installed
#      (set SAPI_REQUIRE_SIGNATURE=1 to refuse an unsigned or unverified release)
#   5. installs to ~/.local/bin/sapi (no root, no sudo, no shell profile edits)
#
# Settings (environment variables):
#   SAPI_VERSION            a release such as 0.1.0 (default: the latest release)
#   SAPI_INSTALL_DIR        where to put the binary (default: ~/.local/bin)
#   SAPI_DOWNLOAD_BASE      a folder URL holding sapi-<os>-<arch> and SHA256SUMS (https:// or file://)
#   SAPI_REQUIRE_SIGNATURE  1 to require a verified cosign signature
set -eu

# TODO before the first release: the GitHub repository that publishes releases (see CODEOWNERS).
REPO="YOUR_GITHUB_HANDLE/sapi"

say() { printf '%s\n' "$*" >&2; }
fail() {
  say "sapi install: $*"
  exit 1
}

if [ "$(id -u)" = "0" ]; then
  fail "don't run this as root. sapi runs as your normal user and installs into your home folder."
fi

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s): sapi runs on macOS and Linux" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported CPU $(uname -m): sapi supports x64 and arm64" ;;
esac
# An x64 shell under Rosetta on Apple silicon: install the native binary.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
asset="sapi-$os-$arch"

version="${SAPI_VERSION:-}"
if [ -n "$version" ]; then
  case "$version" in
    *[!0-9A-Za-z.+-]*) fail "SAPI_VERSION looks wrong: $version" ;;
  esac
  version="${version#v}"
fi

base="${SAPI_DOWNLOAD_BASE:-}"
if [ -z "$base" ]; then
  case "$REPO" in
    YOUR_GITHUB_HANDLE/*) fail "this copy of the installer has no release source yet. Set SAPI_DOWNLOAD_BASE." ;;
  esac
  if [ -n "$version" ]; then
    base="https://github.com/$REPO/releases/download/v$version"
  else
    base="https://github.com/$REPO/releases/latest/download"
  fi
fi
case "$base" in
  https://* | file://*) ;;
  *) fail "SAPI_DOWNLOAD_BASE must start with https:// (or file:// for a local folder)" ;;
esac
base="${base%/}"

command -v curl >/dev/null 2>&1 || fail "curl is needed (sudo apt install curl, or your system's equivalent)"
if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is needed to check the download"
fi

umask 077
tmp="$(mktemp -d 2>/dev/null || mktemp -d -t sapi-install)"
trap 'rm -rf "$tmp"' EXIT INT TERM

get() {
  # --proto limits redirects to https (file:// only for an explicit local folder).
  case "$base" in
    file://*) curl -fsSL --proto '=file' -o "$2" "$1" ;;
    *) curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$2" "$1" ;;
  esac
}

say "Downloading $asset${version:+ $version}"
get "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "couldn't download SHA256SUMS from $base"
get "$base/$asset" "$tmp/$asset" || fail "couldn't download $asset from $base"

expected="$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1 }' "$tmp/SHA256SUMS")"
case "$expected" in
  "") fail "SHA256SUMS has no entry for $asset" ;;
  *[!0-9a-f]*) fail "SHA256SUMS has a malformed entry for $asset" ;;
esac
[ "${#expected}" -eq 64 ] || fail "SHA256SUMS has a malformed entry for $asset"
actual="$(sha "$tmp/$asset")"
if [ "$actual" != "$expected" ]; then
  fail "checksum mismatch for $asset: expected $expected, got $actual. Nothing was installed."
fi
say "✓ checksum verified ($asset)"

signed=no
if get "$base/SHA256SUMS.sig" "$tmp/SHA256SUMS.sig" 2>/dev/null && get "$base/SHA256SUMS.pem" "$tmp/SHA256SUMS.pem" 2>/dev/null; then
  if command -v cosign >/dev/null 2>&1; then
    cosign verify-blob \
      --certificate "$tmp/SHA256SUMS.pem" \
      --signature "$tmp/SHA256SUMS.sig" \
      --certificate-identity-regexp "^https://github.com/$REPO/\\.github/workflows/release\\.yml@" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$tmp/SHA256SUMS" >/dev/null 2>&1 || fail "the signature on SHA256SUMS doesn't verify. Nothing was installed."
    signed=yes
    say "✓ signature verified (cosign, release workflow of $REPO)"
  else
    say "! this release is signed; install cosign to have the signature checked too"
  fi
else
  say "! this release has no signature to check"
fi
if [ "${SAPI_REQUIRE_SIGNATURE:-0}" = 1 ] && [ "$signed" != yes ]; then
  fail "SAPI_REQUIRE_SIGNATURE=1 but the signature wasn't verified. Nothing was installed."
fi

dir="${SAPI_INSTALL_DIR:-$HOME/.local/bin}"
case "$dir" in
  /*) ;;
  *) fail "SAPI_INSTALL_DIR must be an absolute path" ;;
esac
mkdir -p "$dir"
# Copy next to the target, then rename: a running sapi keeps its old file, and a half-copied
# binary is never left in place.
cp "$tmp/$asset" "$dir/.sapi.new.$$"
chmod 755 "$dir/.sapi.new.$$"
mv -f "$dir/.sapi.new.$$" "$dir/sapi"
installed="$("$dir/sapi" --version 2>/dev/null)" || fail "the installed binary didn't run: $dir/sapi"
say "✓ installed sapi $installed to $dir/sapi"

case ":$PATH:" in
  *":$dir:"*) say "" && say "Next: sapi setup" ;;
  *)
    say ""
    say "$dir isn't on your PATH. Add it to your shell profile, for example:"
    say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile && . ~/.profile"
    say "Next: $dir/sapi setup"
    ;;
esac
