import createJsffiImports from "@dhall-wasm/engine/engine.js";
import { err, failure, ok, type DhallDiagnostic, type DhallErrorKind, type Result } from "./errors.ts";
import type { DhallTypeSchema } from "./schema.ts";
import type {
  DhallEngine,
  DhallEnvironment,
  EvaluateOptions,
  ImportRequest,
  ImportResolution,
  TypeCheckOptions,
  DescribeTypeOptions,
} from "./engine.ts";

const DEFAULT_WASM_URL = new URL("../../engine/wasm/engine.wasm", import.meta.url);

export interface WasmEngineOptions {
  /** Location of `engine.wasm`. Defaults to `DHALL_WASM_ENGINE` or the bundled artifact. */
  readonly wasmUrl?: string | URL;
  /** Override the GHC-generated JSFFI import factory, mainly for tests. */
  readonly createImports?: typeof createJsffiImports;
}

type ExportedFunction = (...args: unknown[]) => Promise<string>;

interface WasmExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  evaluate(resolver: ImportCallback, request: string): Promise<string>;
  typeCheck(resolver: ImportCallback, request: string): Promise<string>;
  describeType(resolver: ImportCallback, request: string): Promise<string>;
  [name: string]: unknown;
}

interface Envelope<T> {
  ok: boolean;
  value?: T;
  error?: {
    kind?: string;
    message?: string;
    source?: string | null;
  };
}

type ImportCallback = (request: string) => Promise<string>;

const ERROR_KINDS: readonly DhallErrorKind[] = [
  "parse",
  "typecheck",
  "import",
  "integrity",
  "evaluation",
  "engine",
  "unsupported",
];

const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

function errorMessage(error: unknown): string {
  return stripAnsi(error instanceof Error ? error.message : String(error));
}

function toDiagnostic(envelope: Envelope<unknown>): DhallDiagnostic {
  const error = envelope.error ?? {};
  const kind = ERROR_KINDS.find((candidate) => candidate === error.kind) ?? "engine";
  const source = error.source && error.source.length > 0 ? error.source : undefined;
  return {
    kind,
    message: stripAnsi(error.message ?? "The Dhall engine returned an error"),
    source,
  };
}

interface NodeUrlModule {
  pathToFileURL(path: string): URL;
}

interface NodeFsModule {
  readFile(path: URL | string): Promise<Uint8Array>;
}

// Keep the specifiers dynamic so browser bundlers do not try to resolve Node
// builtins that are only used when running under Node/Bun.
function nodeUrlModule(): Promise<NodeUrlModule> {
  return import("node:" + "url") as Promise<NodeUrlModule>;
}

function nodeFsModule(): Promise<NodeFsModule> {
  return import("node:" + "fs/promises") as Promise<NodeFsModule>;
}

function processEnvironment(): Record<string, string | undefined> | undefined {
  return typeof process === "undefined" ? undefined : process.env;
}

async function configuredWasmUrl(): Promise<URL | undefined> {
  const configured = processEnvironment()?.DHALL_WASM_ENGINE;
  if (!configured) return undefined;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(configured)) {
    return new URL(configured);
  }

  const { pathToFileURL } = await nodeUrlModule();
  return pathToFileURL(configured);
}

async function readWasm(url: URL): Promise<Uint8Array> {
  if (url.protocol === "file:") {
    const { readFile } = await nodeFsModule();
    return new Uint8Array(await readFile(url));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load Dhall engine from ${url.href}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Minimal WASI preview1 surface used by the GHC runtime.  The bridge performs
 * no filesystem or process IO; these imports exist so the runtime can read the
 * clock and observe empty arguments and environment variables.
 */
function createWasiImports(getMemory: () => WebAssembly.Memory | undefined): Record<string, unknown> {
  const errno = { success: 0, badf: 8, nosys: 52 } as const;

  const withMemory = <T>(fallback: T, operation: (view: DataView) => T): T => {
    const memory = getMemory();
    return memory ? operation(new DataView(memory.buffer)) : fallback;
  };

  const writeU32 = (view: DataView, offset: number, value: number): void => {
    view.setUint32(offset, value >>> 0, true);
  };

  return {
    args_get: () => errno.success,
    args_sizes_get: (argc: number, size: number) =>
      withMemory(errno.success, (view) => {
        writeU32(view, argc, 0);
        writeU32(view, size, 0);
        return errno.success;
      }),
    environ_get: () => errno.success,
    environ_sizes_get: (count: number, size: number) =>
      withMemory(errno.success, (view) => {
        writeU32(view, count, 0);
        writeU32(view, size, 0);
        return errno.success;
      }),
    clock_time_get: (_clock: number, _precision: bigint, out: number) =>
      withMemory(errno.success, (view) => {
        view.setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);
        return errno.success;
      }),
    fd_close: () => errno.success,
    fd_fdstat_get: (fd: number, out: number) =>
      withMemory(errno.success, (view) => {
        for (let offset = 0; offset < 24; offset += 1) view.setUint8(out + offset, 0);
        view.setUint8(out, fd <= 2 ? 2 : 0);
        return fd <= 2 ? errno.success : errno.badf;
      }),
    fd_fdstat_set_flags: () => errno.success,
    fd_filestat_get: () => errno.badf,
    fd_filestat_set_size: () => errno.badf,
    fd_prestat_dir_name: () => errno.badf,
    fd_prestat_get: () => errno.badf,
    fd_read: (_fd: number, _iovs: number, _len: number, nread: number) =>
      withMemory(errno.success, (view) => {
        writeU32(view, nread, 0);
        return errno.success;
      }),
    fd_seek: () => errno.badf,
    fd_write: (_fd: number, iovs: number, len: number, nwritten: number) =>
      withMemory(errno.success, (view) => {
        let written = 0;
        for (let index = 0; index < len; index += 1) {
          written += view.getUint32(iovs + index * 8 + 4, true);
        }
        writeU32(view, nwritten, written);
        return errno.success;
      }),
    path_create_directory: () => errno.badf,
    path_filestat_get: () => errno.badf,
    path_open: () => errno.badf,
    poll_oneoff: () => errno.success,
    proc_exit: (code: number) => {
      throw new Error(`Dhall engine exited with status ${code}`);
    },
    sched_yield: () => errno.success,
    random_get: () => errno.nosys,
  };
}

function defaultEnvironment(remoteImports: boolean | undefined): DhallEnvironment {
  return {
    async resolveImport(request: ImportRequest): Promise<ImportResolution> {
      const specifier = request.specifier;
      if (/^env:/.test(specifier)) {
        throw new Error(`Missing environment variable import: ${specifier}`);
      }

      const base = request.baseDirectory;
      const hasBase = base !== undefined && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(base);
      const browserBase = typeof location === "undefined" ? undefined : location.href;
      const url = new URL(specifier, hasBase ? base : browserBase);

      if (!remoteImports && url.protocol !== "file:" && url.protocol !== "data:") {
        throw new Error(
          `Remote import ${specifier} is disabled; pass remoteImports: true to allow it`,
        );
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${specifier}: ${response.status} ${response.statusText}`);
      }
      return { text: await response.text(), source: url.href };
    },
  };
}

function requestFor(
  op: string,
  source: string,
  options: { readonly format?: string; readonly sourcePath?: string; readonly environment?: DhallEnvironment },
): string {
  return JSON.stringify({
    op,
    source,
    format: options.format ?? "json",
    sourcePath: options.sourcePath ?? "source",
    variables: options.environment?.variables ?? {},
  });
}

function importCallback(environment: DhallEnvironment | undefined, remoteImports: boolean | undefined): ImportCallback {
  const resolver = environment ?? defaultEnvironment(remoteImports);
  return async (raw: string): Promise<string> => {
    try {
      const request = JSON.parse(raw) as ImportRequest;
      const resolution = await resolver.resolveImport(request);
      return JSON.stringify({
        ok: true,
        text: resolution.text,
        source: resolution.source ?? request.specifier,
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: { kind: "import", message: errorMessage(error) },
      });
    }
  };
}

function makeEngine(exports: WasmExports): DhallEngine {
  async function invoke<T>(name: "evaluate" | "typeCheck" | "describeType", raw: string, resolve: ImportCallback): Promise<Result<T>> {
    try {
      const function_ = exports[name] as ExportedFunction;
      const response = await function_(resolve, raw);
      const envelope = JSON.parse(response) as Envelope<T>;
      return envelope.ok ? ok(envelope.value as T) : failure(toDiagnostic(envelope));
    } catch (error) {
      return err("engine", errorMessage(error));
    }
  }

  return {
    evaluate(source: string, options: EvaluateOptions = { format: "json" }) {
      return invoke<unknown>(
        "evaluate",
        requestFor("evaluate", source, options),
        importCallback(options.environment, options.remoteImports),
      );
    },
    typeCheck(source: string, options: TypeCheckOptions = {}) {
      return invoke<string>(
        "typeCheck",
        requestFor("typeCheck", source, options),
        importCallback(options.environment, options.remoteImports),
      );
    },
    describeType(source: string, options: DescribeTypeOptions = {}) {
      return invoke<DhallTypeSchema>(
        "describeType",
        requestFor("describeType", source, options),
        importCallback(options.environment, options.remoteImports),
      );
    },
  };
}

/** Instantiate the official Haskell Dhall engine from its WASM artifact. */
export async function loadWasmEngine(options: WasmEngineOptions = {}): Promise<DhallEngine> {
  const url = options.wasmUrl ? toUrl(options.wasmUrl) : await configuredWasmUrl() ?? DEFAULT_WASM_URL;
  const source = await readWasm(url);

  const exports: Record<string, unknown> = {};
  const createImports = options.createImports ?? createJsffiImports;
  const jsffi = createImports(exports as Parameters<typeof createImports>[0]);
  let memory: WebAssembly.Memory | undefined;

  const imports: WebAssembly.Imports = {
    ghc_wasm_jsffi: jsffi as unknown as WebAssembly.ModuleImports,
    wasi_snapshot_preview1: createWasiImports(() => memory) as WebAssembly.ModuleImports,
  };
  const { instance } = await WebAssembly.instantiate(source, imports);

  Object.assign(exports, instance.exports);
  const wasmExports = exports as unknown as WasmExports;
  memory = wasmExports.memory;
  wasmExports._initialize();

  return makeEngine(wasmExports);
}

function toUrl(location: string | URL): URL {
  return typeof location === "string" ? new URL(location) : location;
}
