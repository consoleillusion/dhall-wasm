# Engine

This package will hold the Haskell bridge and the `wasm32-wasi` build that
produces `wasm/engine.wasm`. The checked-in file is a placeholder empty WASM
module so that the CLI and Nix packaging can be exercised before the engine
exists.

Consumers never build this package; the compiled artifact is shipped in the
published packages and in the Nix CLI derivation.

## Building the real engine

The `wasm32-wasi` GHC cross-compiler is **opt-in** so that `nix run .` and
`nix develop` stay fast:

```bash
nix develop .#engine
wasm32-wasi-ghc --version
```

This shell comes from the `ghc-wasm-nix` flake input, which integrates
`ghc-wasm-meta`'s prebuilt bindists with nixpkgs' Haskell package set. It also
provides `wasm32-wasi-cabal`, `wasm-opt`, `wasm-tools`, `wizer`, and `wasmtime`.

The toolchain is deliberately only a development shell, not a package output.
`nix build .` and `nix run .` produce the CLI with its prebuilt engine artifact
and never depend on GHC; regular users do not need a Haskell compiler.

On `x86_64-darwin`, the engine shell is intentionally omitted because the GHC
WASM bindists do not support that platform.
