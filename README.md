# dhall-wasm

Dhall for TypeScript projects. One implementation, two interfaces:

- `@dhall-wasm/core` — the TypeScript library (`evaluate`, `typeCheck`, `describeType`, `generateTypes`).
- `@dhall-wasm/cli` — a [`cmd-ts`](https://github.com/Schniz/cmd-ts) CLI that calls the library.

The Dhall engine itself is compiled from Haskell to WebAssembly. `packages/engine/wasm/engine.wasm` is currently a placeholder; until the engine build lands, evaluation reports a clear `engine` error.

## Development

```bash
bun install
bun run typecheck
bun test
bun run cli -- --help
```

## Nix

```bash
nix run . -- --help
nix run . -- eval ./config.dhall
nix develop
```

`nix run .` invokes the CLI directly; arguments after `--` are forwarded.
Dependencies are fetched from the checked-in `bun.lock` in a fixed-output
derivation, so no Haskell toolchain or preinstalled `node_modules` are needed.

### Haskell / WASM toolchain (opt-in)

The default shell and default app stay lightweight. The `wasm32-wasi` GHC
cross-compiler is available separately:

```bash
nix develop .#engine   # or: nix develop .#haskell
wasm32-wasi-ghc --version
wasm32-wasi-cabal --version
```

The toolchain comes from `ghc-wasm-nix`, which wraps the prebuilt bindists from
`ghc-wasm-meta` in nixpkgs' Haskell infrastructure. You can also install just
the compiler without entering a shell:

```bash
nix profile install .#ghc
nix build .#ghc
```

`post-link.mjs` is included in the GHC derivation's `lib/` directory, and the
shell additionally provides `wasm-opt`, `wasm-tools`, `wizer`, and `wasmtime`.

On `x86_64-darwin`, only the CLI and default shell are provided; the GHC WASM
bindists do not support that system.
