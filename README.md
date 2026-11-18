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
