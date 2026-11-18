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

export interface EvaluateOptions {
  readonly format: OutputFormat;
  readonly environment?: DhallEnvironment;
  readonly remoteImports?: boolean;
}

export interface TypeCheckOptions {
  readonly environment?: DhallEnvironment;
  readonly remoteImports?: boolean;
}

export interface DescribeTypeOptions {
  readonly environment?: DhallEnvironment;
  readonly remoteImports?: boolean;
}

export interface DhallEngine {
  evaluate(source: string, options: EvaluateOptions): Promise<Result<unknown>>;
  typeCheck(source: string, options: TypeCheckOptions): Promise<Result<string>>;
  describeType(
    source: string,
    options: DescribeTypeOptions,
  ): Promise<Result<DhallTypeSchema>>;
}

const unavailable: DhallEngine = {
  async evaluate() {
    return err("engine", new EngineNotBuiltError().message);
  },
  async typeCheck() {
    return err("engine", new EngineNotBuiltError().message);
  },
  async describeType() {
    return err("engine", new EngineNotBuiltError().message);
  },
};

let currentEngine: DhallEngine = unavailable;

/** Replace the active engine (used by the WASM loader and by tests). */
export function setEngine(engine: DhallEngine): void {
  currentEngine = engine;
}

/** Restore the placeholder engine that reports the artifact has not been built. */
export function clearEngine(): void {
  currentEngine = unavailable;
}

export function getEngine(): DhallEngine {
  return currentEngine;
}

export async function evaluate(
  source: string,
  options: EvaluateOptions = { format: "json" },
): Promise<Result<unknown>> {
  return currentEngine.evaluate(source, options);
}

export async function typeCheck(
  source: string,
  options: TypeCheckOptions = {},
): Promise<Result<string>> {
  return currentEngine.typeCheck(source, options);
}

export async function describeType(
  source: string,
  options: DescribeTypeOptions = {},
): Promise<Result<DhallTypeSchema>> {
  return currentEngine.describeType(source, options);
}
