# Engine

This package contains the small Haskell bridge around the official
`dhall-haskell` library and the generated WebAssembly artifacts in `wasm/`:

- `engine.wasm` — the compiled engine (~4 MB after `wasm-opt -Oz`).
- `engine.js` — GHC's generated JSFFI import factory.
- `engine.d.ts` — types for that factory.

Consumers never build this package. The core library loads the checked-in
artifact and the CLI/Nix derivation ships it alongside the executable.

## Sources and dependencies

`src/Bridge.hs` is the only substantial Haskell source. Dhall itself is fetched
from a pinned upstream commit by `cabal.project`; no third-party Haskell source
is vendored in this repository.

The one build-specific Cabal option selects cborg's 64-bit code path: GHC 9.14
removed `GHC.IntWord64`, which cborg 0.2.10.0's 32-bit branch imports. The
wasm32-wasi target supports the required 64-bit primops, so no source patch is
needed.

## Building the real engine

The `wasm32-wasi` GHC cross-compiler is **opt-in** so that `nix run .` and
`nix develop` stay fast:

```bash
bun run build:engine
# or, from the engine shell directly:
nix develop .#engine --command bash packages/engine/scripts/build.sh
```

The script runs `cabal build`, GHC's `post-link.mjs`, and `wasm-opt -Oz`, then
replaces `wasm/engine.js` and `wasm/engine.wasm`. Cabal's package index and
store are kept outside the repository; set `DHALL_WASM_CABAL_HOME` to reuse an
existing cache.

This shell comes from the `ghc-wasm-nix` flake input, which integrates
`ghc-wasm-meta`'s prebuilt bindists with nixpkgs' Haskell package set. It also
provides `wasm32-wasi-cabal`, `wasm-opt`, `wasm-tools`, `wizer`, and `wasmtime`.

The toolchain is deliberately only a development shell, not a package output.
`nix build .` and `nix run .` produce the CLI with its prebuilt engine artifact
and never depend on GHC; regular users do not need a Haskell compiler.

On `x86_64-darwin`, the engine shell is intentionally omitted because the GHC
WASM bindists do not support that platform.
