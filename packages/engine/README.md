# Engine

This package will hold the Haskell bridge and the `wasm32-wasi` build that
produces `wasm/engine.wasm`. The checked-in file is a placeholder empty WASM
module so that the CLI and Nix packaging can be exercised before the engine
exists.

Consumers never build this package; the compiled artifact is shipped in the
published packages and in the Nix CLI derivation.
