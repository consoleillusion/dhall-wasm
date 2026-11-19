import { EngineNotBuiltError, err, type Result } from "./errors.ts";
import type { DhallTypeSchema } from "./schema.ts";

export type OutputFormat = "json" | "dhall" | "cbor";

export interface DhallValue {
  [key: string]: unknown;
}

export interface ImportRequest {
  /** The raw import specifier, e.g. `./config.dhall` or `https://...`. */
  readonly specifier: string;
  /** Expected sha256 integrity hash, when the import declares one. */
  readonly expectedHash?: string;
  /** Base path for resolving relative imports. */
  readonly baseDirectory?: string;
}

export interface ImportResolution {
  readonly text: string;
  /** A label for diagnostics, such as the resolved file path or URL. */
  readonly source?: string;
}

export interface DhallEnvironment {
  resolveImport(request: ImportRequest): Promise<ImportResolution>;
  readonly variables?: Readonly<Record<string, string>>;
}

export interface SourceOptions {
  /** Source label used in diagnostics and as the base for relative imports. */
  readonly sourcePath?: string;
}

export interface EvaluateOptions extends SourceOptions {
  readonly format: OutputFormat;
  readonly environment?: DhallEnvironment;
  readonly remoteImports?: boolean;
}

export interface TypeCheckOptions extends SourceOptions {
  readonly environment?: DhallEnvironment;
  readonly remoteImports?: boolean;
}

export interface DescribeTypeOptions extends SourceOptions {
  readonly environment?: DhallEnvironment;
  readonly remoteImports?: boolean;
}

export interface DhallEngine {
  evaluate(source: string, options?: EvaluateOptions): Promise<Result<unknown>>;
  typeCheck(source: string, options?: TypeCheckOptions): Promise<Result<string>>;
  describeType(
    source: string,
    options?: DescribeTypeOptions,
  ): Promise<Result<DhallTypeSchema>>;
}

function errorEngine(message: string): DhallEngine {
  return {
    async evaluate() {
      return err("engine", message);
    },
    async typeCheck() {
      return err("engine", message);
    },
    async describeType() {
      return err("engine", message);
    },
  };
}

const unavailable: DhallEngine = errorEngine(new EngineNotBuiltError().message);

let explicitEngine: DhallEngine | undefined;
let disabled = false;
let initialization: Promise<DhallEngine> | undefined;

/** Replace the active engine (used by the WASM loader and by tests). */
export function setEngine(engine: DhallEngine): void {
  explicitEngine = engine;
  disabled = false;
  initialization = Promise.resolve(engine);
}

/** Restore the placeholder engine that reports the artifact has not been built. */
export function clearEngine(): void {
  explicitEngine = unavailable;
  disabled = true;
  initialization = undefined;
}

export function getEngine(): DhallEngine {
  return explicitEngine ?? unavailable;
}

/** Explicitly initialize the WASM engine. Library calls also initialize it lazily. */
export async function initializeEngine(
  options?: import("./wasm.ts").WasmEngineOptions,
): Promise<DhallEngine> {
  const { loadWasmEngine } = await import("./wasm.ts");
  const engine = await loadWasmEngine(options);
  setEngine(engine);
  return engine;
}

async function ensureEngine(): Promise<DhallEngine> {
  if (explicitEngine) return explicitEngine;
  if (disabled) return unavailable;

  initialization ??= import("./wasm.ts")
    .then(({ loadWasmEngine }) => loadWasmEngine())
    .then((engine) => {
      explicitEngine = engine;
      return engine;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const failed = errorEngine(`Unable to load the Dhall WASM engine: ${message}`);
      explicitEngine = failed;
      return failed;
    });

  return initialization;
}

export async function evaluate(
  source: string,
  options: EvaluateOptions = { format: "json" },
): Promise<Result<unknown>> {
  const engine = await ensureEngine();
  return engine.evaluate(source, options);
}

export async function typeCheck(
  source: string,
  options: TypeCheckOptions = {},
): Promise<Result<string>> {
  const engine = await ensureEngine();
  return engine.typeCheck(source, options);
}

export async function describeType(
  source: string,
  options: DescribeTypeOptions = {},
): Promise<Result<DhallTypeSchema>> {
  const engine = await ensureEngine();
  return engine.describeType(source, options);
}
