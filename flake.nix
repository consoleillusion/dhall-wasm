{
  description = "Dhall for TypeScript projects: library, CLI, and WASM engine";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    ghc-wasm-nix = {
      url = "github:ilkecan/ghc-wasm-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, ghc-wasm-nix }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f {
            inherit system;
            basePkgs = import nixpkgs { inherit system; };
            wasmPkgs = import nixpkgs {
              inherit system;
              overlays = [ ghc-wasm-nix.overlays.default ];
            };
          }
        );

      # x86_64-darwin is supported by the CLI but not by the GHC WASM bindists.
      wasmSystems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
    in
    {
      # The default package is the CLI with its prebuilt engine artifact, so
      # npm/bun/node/ts consumers and `nix run .` never need GHC. Maintainer-
      # only compiler outputs are available as explicit opt-ins and are never
      # dependencies of `default`.
      packages = forAllSystems ({ basePkgs, wasmPkgs, system, ... }:
        {
          default = basePkgs.callPackage ./nix/cli.nix { inherit self; };
        }
        // nixpkgs.lib.optionalAttrs (builtins.elem system wasmSystems) {
          ghc = wasmPkgs.haskellWasmPackages.ghc;
          cabal = wasmPkgs.haskellWasmCabal;
        });

      apps = forAllSystems ({ system, ... }: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/dhall-ts";
        };
      });

      devShells = forAllSystems ({ basePkgs, wasmPkgs, system, ... }:
        let
          defaultShell = basePkgs.mkShell {
            packages = [
              basePkgs.bun
              basePkgs.nodejs_22
            ];
          };

          # `nix develop .#engine` (or .#haskell) gives the wasm32-wasi GHC
          # toolchain without changing the default shell or the default app.
          engineShell = wasmPkgs.mkShell {
            packages = [
              wasmPkgs.bun
              wasmPkgs.nodejs_22
              wasmPkgs.haskellWasmCabal
              wasmPkgs.haskellWasmPackages.ghc
              wasmPkgs.haskellWasmPackages.ghc.nodejs
              wasmPkgs.binaryen
              wasmPkgs.wasm-tools
              wasmPkgs.wizer
              wasmPkgs.wasmtime
            ];
          };
        in
        { default = defaultShell; }
        // nixpkgs.lib.optionalAttrs (builtins.elem system wasmSystems) {
          engine = engineShell;
          haskell = engineShell;
        });
    };
}
