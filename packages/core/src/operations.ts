import {
  describeType,
  evaluate,
  type DescribeTypeOptions,
  type EvaluateOptions,
  type OutputFormat,
} from "./engine.ts";
import { failure, ok, type DhallDiagnostic, type Result } from "./errors.ts";
import { generateTypes, type GeneratedTypes, type GenerateTypesOptions } from "./schema.ts";

/** Every output format supported by both the library and the CLI. */
export const OUTPUT_FORMATS = ["json", "dhall", "cbor"] as const;

/** The format used when a caller does not specify one. */
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "json";

function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function renderDhall(value: unknown): string {
  if (value === null || value === undefined) return "None Type";

  switch (typeof value) {
    case "boolean":
      return value ? "True" : "False";
    case "number":
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return value.toString();
  }

  if (value instanceof Uint8Array) {
    return JSON.stringify(Array.from(value));
  }

  if (Array.isArray(value)) {
    return `[ ${value.map(renderDhall).join(", ")} ]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const fields = entries.map(([key, item]) => {
      const renderedKey = isIdentifier(key) ? key : JSON.stringify(key);
      return `${renderedKey} = ${renderDhall(item)}`;
    });
    return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
  }

  return JSON.stringify(value);
}

/** Render an evaluated value in one of the supported output formats. */
export function formatValue(value: unknown, format: OutputFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(value, null, 2);
    // The WASM engine returns normalized Dhall text for this format.
    case "dhall":
      return typeof value === "string" ? value : renderDhall(value);
    // The WASM engine returns CBOR as a hex string using its canonical encoder.
    case "cbor":
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

/** Render a diagnostic identically for library loggers and CLI output. */
export function formatDiagnostic(error: DhallDiagnostic): string {
  const location = error.location
    ? ` (${error.source ?? "source"}:${error.location.line ?? error.location.start})`
    : "";
  return `${error.kind}: ${error.message}${location}`;
}

export async function evaluateToText(
  source: string,
  options: EvaluateOptions = { format: DEFAULT_OUTPUT_FORMAT },
): Promise<Result<string>> {
  const result = await evaluate(source, options);
  if (!result.ok) return failure(result.error);
  return ok(formatValue(result.value, options.format));
}

export interface GenerateTypesFromSourceOptions
  extends DescribeTypeOptions,
    GenerateTypesOptions {}

/** Describe a Dhall type expression and generate TypeScript code in one call. */
export async function generateTypesFromSource(
  source: string,
  options: GenerateTypesFromSourceOptions,
): Promise<Result<GeneratedTypes>> {
  const described = await describeType(source, options);
  if (!described.ok) return failure(described.error);
  return ok(
    generateTypes(described.value, {
      name: options.name,
      validator: options.validator,
    }),
  );
}
