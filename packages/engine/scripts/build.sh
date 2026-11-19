#!/usr/bin/env bash
set -euo pipefail

# Rebuild the checked-in WASM engine artifacts.  This script is for maintainers:
# normal consumers never run it.  Use `bun run build:engine` from the repo root,
# or run it directly from `nix develop .#engine`.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
engine_dir="$repo_root/packages/engine"

if ! command -v wasm32-wasi-ghc >/dev/null 2>&1; then
  echo "error: wasm32-wasi-ghc not found; run 'nix develop .#engine' first" >&2
  exit 1
fi

# Keep Cabal's package index and store outside the repository.  Override with
# DHALL_WASM_CABAL_HOME to reuse an existing cache between shells.
export HOME="${DHALL_WASM_CABAL_HOME:-$HOME/.cache/dhall-wasm/cabal-home}"
mkdir -p "$HOME"

# Pass explicit paths: cabal still looks for an unprefixed `ghc-pkg` while
# re-resolving dependencies, which the WASM bindist does not provide.  A
# temporary PATH shim keeps that workaround inside this maintainer script;
# consumers never see it and the Nix shell needs no changes.
ghc="$(command -v wasm32-wasi-ghc)"
ghc_pkg="$(command -v wasm32-wasi-ghc-pkg)"
shim_dir="$(mktemp -d)"
trap 'rm -rf "$shim_dir"' EXIT
ln -s "$ghc_pkg" "$shim_dir/ghc-pkg"
export PATH="$shim_dir:$PATH"

wasm32-wasi-cabal update --with-compiler="$ghc" --with-hc-pkg="$ghc_pkg"

cd "$engine_dir"
wasm32-wasi-cabal build exe:dhall-engine \
  --with-compiler="$ghc" \
  --with-hc-pkg="$ghc_pkg"
wasm="$(find dist-newstyle -type f -name dhall-engine.wasm -print -quit)"
if [[ -z "$wasm" ]]; then
  echo "error: could not locate the built dhall-engine.wasm" >&2
  exit 1
fi
libdir="$(wasm32-wasi-ghc --print-libdir)"

mkdir -p wasm
node "$libdir/post-link.mjs" -i "$wasm" -o wasm/engine.js
wasm-opt -Oz --enable-bulk-memory --enable-mutable-globals --enable-sign-ext \
  -o wasm/engine.wasm "$wasm"

echo "Built $engine_dir/wasm/engine.wasm"
