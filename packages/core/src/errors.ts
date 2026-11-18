export type DhallErrorKind =
  | "parse"
  | "typecheck"
  | "import"
  | "integrity"
  | "evaluation"
  | "engine"
  | "unsupported";

export interface SourceLocation {
  start: number;
  end?: number;
  line?: number;
  column?: number;
}

export interface DhallDiagnostic {
  kind: DhallErrorKind;
  message: string;
  source?: string;
  location?: SourceLocation;
  cause?: unknown;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DhallDiagnostic };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  kind: DhallErrorKind,
  message: string,
  details: Omit<DhallDiagnostic, "kind" | "message"> = {},
): Result<T> {
  return { ok: false, error: { kind, message, ...details } };
}

export class DhallError extends Error {
  readonly diagnostic: DhallDiagnostic;

  constructor(diagnostic: DhallDiagnostic) {
    super(diagnostic.message);
    this.name = "DhallError";
    this.diagnostic = diagnostic;
  }
}

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new DhallError(result.error);
}

export class EngineNotBuiltError extends DhallError {
  constructor() {
    super({
      kind: "engine",
      message:
        "The Dhall engine is not built yet. Run the engine build (or install a published package with the prebuilt WASM artifact) before evaluating expressions.",
    });
    this.name = "EngineNotBuiltError";
  }
}
