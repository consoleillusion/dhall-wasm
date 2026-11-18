{
  lib,
  stdenv,
  bun,
  makeWrapper,
  self,
}:

let
  pname = "dhall-ts";
  version = "0.1.0";

  # `bun.lock` is the single source of truth. fetchNpmDeps does not understand
  # it, so dependencies are fetched in a fixed-output derivation that runs
  # `bun install --frozen-lockfile`.
  nodeModules = stdenv.mkDerivation {
    pname = "${pname}-node-modules";
    inherit version;
    src = self;

    impureEnvVars =
      lib.fetchers.proxyImpureEnvVars
      ++ [
        "HTTP_PROXY"
        "HTTPS_PROXY"
        "ALL_PROXY"
        "NO_PROXY"
        "http_proxy"
        "https_proxy"
        "all_proxy"
        "no_proxy"
      ];

    nativeBuildInputs = [ bun ];

    dontConfigure = true;

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
      bun install --frozen-lockfile --ignore-scripts --no-progress
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -a ./. $out/
      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-pwcCxNukX3gP+00LrxQQp2zjYt4hhH1bxn03Pt2PuyY=";
  };
in
stdenv.mkDerivation {
  inherit pname version;
  src = self;

  nativeBuildInputs = [ bun makeWrapper ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    rm -rf node_modules packages/cli/node_modules
    cp -a ${nodeModules}/node_modules ./node_modules
    cp -a ${nodeModules}/packages/cli/node_modules ./packages/cli/node_modules
    bun build ./packages/cli/src/main.ts --target=bun --outfile=dhall-ts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/share/dhall-wasm
    install -m755 dhall-ts $out/bin/dhall-ts
    cp packages/engine/wasm/engine.wasm $out/share/dhall-wasm/engine.wasm
    wrapProgram $out/bin/dhall-ts \
      --set DHALL_WASM_ENGINE "$out/share/dhall-wasm/engine.wasm" \
      --prefix PATH : ${lib.makeBinPath [ bun ]}
    runHook postInstall
  '';

  meta = {
    description = "Dhall for TypeScript projects: CLI and library";
    mainProgram = "dhall-ts";
  };
}
