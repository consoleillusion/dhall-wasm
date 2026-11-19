# dhall-wasm

Dhall for TypeScript projects. One implementation, two interfaces:

- `@dhall-wasm/core` — the TypeScript library (`evaluate`, `typeCheck`, `describeType`, `generateTypes`).
- `@dhall-wasm/cli` — a [`cmd-ts`](https://github.com/Schniz/cmd-ts) CLI that calls the library.

The Dhall engine itself is compiled from Haskell to WebAssembly, but **consumers
never compile it**. Published packages ship the prebuilt `engine.wasm`, so
`npm`, `bun`, Node, and browser users need no Haskell toolchain at install time
or runtime. `packages/engine/wasm/engine.wasm` in this repo is currently a
placeholder; until the real engine build lands, evaluation reports a clear
`engine` error.

## Using the library

```bash
bun add @dhall-wasm/core
# or: npm install @dhall-wasm/core
```

No Haskell compiler, cabal, or Nix is involved in this path.

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
`ghc-wasm-meta` in nixpkgs' Haskell infrastructure. It is strictly opt-in:
`nix build .` and `nix run .` build only the CLI and never pull in GHC. Contributors
who want an installable compiler without entering a shell can still use:

```bash
nix profile install .#ghc     # also: nix build .#ghc / .#cabal
```

Those outputs are maintainer conveniences, not dependencies of `default`, so
they cannot force a Haskell requirement on package consumers.

`post-link.mjs` is included in the GHC derivation's `lib/` directory, and the
engine shell additionally provides `wasm-opt`, `wasm-tools`, `wizer`, and
`wasmtime`.

On `x86_64-darwin`, only the CLI and default shell are provided; the GHC WASM
bindists do not support that system.
