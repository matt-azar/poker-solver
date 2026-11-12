#!/usr/bin/env bash
# Install the pinned Zig toolchain (Linux x86_64) into ~/.local and print PATH hint.
# Keep version + sha256 in sync with .github/workflows/zig.yml and the store
# zig-toolchain-pin.md document.
set -euo pipefail

ZIG_VERSION="${ZIG_VERSION:-0.14.1}"
ZIG_LINUX_SHA256="${ZIG_LINUX_SHA256:-24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c}"
PREFIX="${ZIG_PREFIX:-$HOME/.local}"
TARBALL_URL="https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz"
DEST="${PREFIX}/zig-x86_64-linux-${ZIG_VERSION}"

mkdir -p "$PREFIX"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ${TARBALL_URL}"
curl -fsSL "$TARBALL_URL" -o "$TMP/zig.tar.xz"
echo "${ZIG_LINUX_SHA256}  $TMP/zig.tar.xz" | sha256sum -c -

if [[ -d "$DEST" ]]; then
  echo "Removing existing ${DEST}"
  rm -rf "$DEST"
fi
tar -xJf "$TMP/zig.tar.xz" -C "$PREFIX"

ln -sfn "$DEST" "${PREFIX}/zig"
echo "Installed: $DEST"
"$DEST/zig" version
echo
echo "Add to PATH:"
echo "  export PATH=\"${DEST}:\$PATH\""
