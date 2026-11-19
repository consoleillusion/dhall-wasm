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

function cborHeader(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value];
  if (value <= 0xff) return [(major << 5) | 24, value];
  if (value <= 0xffff) return [(major << 5) | 25, (value >>> 8) & 0xff, value & 0xff];
  if (value <= 0xffffffff) {
    return [
      (major << 5) | 26,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
  }

  let remaining = BigInt(value);
  const bytes = [(major << 5) | 27];
  for (let index = 7; index >= 0; index--) {
    bytes.push(Number((remaining >> BigInt(index * 8)) & 0xffn));
  }
  return bytes;
}

function cborFloat64(value: number): number[] {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return [0xfb, ...new Uint8Array(buffer)];
}

function encodeCbor(value: unknown): number[] {
  if (value === null || value === undefined) return [0xf6];
  if (typeof value === "boolean") return [value ? 0xf5 : 0xf4];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return cborFloat64(value);
    if (!Number.isInteger(value)) return cborFloat64(value);
    return value >= 0 ? cborHeader(0, value) : cborHeader(1, -1 - value);
  }
  if (typeof value === "bigint") {
    return value >= 0n
      ? cborHeader(0, Number(value))
      : cborHeader(1, Number(-1n - value));
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...cborHeader(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) {
    return [...cborHeader(2, value.length), ...value];
  }
  if (Array.isArray(value)) {
    return [
      ...cborHeader(4, value.length),
      ...value.flatMap((item) => encodeCbor(item)),
    ];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return [
      ...cborHeader(5, entries.length),
      ...entries.flatMap(([key, item]) => [...encodeCbor(key), ...encodeCbor(item)]),
    ];
  }
  return encodeCbor(String(value));
}

function toCborHex(value: unknown): string {
  return encodeCbor(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Render an evaluated value in one of the supported output formats. */
export function formatValue(value: unknown, format: OutputFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(value, null, 2);
    // The WASM engine returns normalized Dhall text for this format.
    case "dhall":
      return typeof value === "string" ? value : renderDhall(value);
    case "cbor":
      return toCborHex(value);
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
