export type DhallPrimitive =
  | "Bool"
  | "Natural"
  | "Integer"
  | "Double"
  | "Text"
  | "Bytes"
  | "Date"
  | "Time"
  | "TimeZone";

export type DhallTypeSchema =
  | { readonly kind: "primitive"; readonly name: DhallPrimitive }
  | { readonly kind: "list"; readonly element: DhallTypeSchema }
  | { readonly kind: "optional"; readonly element: DhallTypeSchema }
  | {
      readonly kind: "record";
      readonly fields: Readonly<Record<string, DhallTypeSchema>>;
    }
  | {
      readonly kind: "union";
      readonly alternatives: Readonly<Record<string, DhallTypeSchema | null>>;
    }
  | {
      readonly kind: "map";
      readonly key: DhallTypeSchema;
      readonly value: DhallTypeSchema;
    }
  | {
      readonly kind: "function";
      readonly argument: DhallTypeSchema;
      readonly result: DhallTypeSchema;
    };

export interface GenerateTypesOptions {
  /** Name of the generated TypeScript type. */
  readonly name: string;
  /** Also generate a runtime validator function. */
  readonly validator?: boolean;
}

export interface GeneratedTypes {
  /** Content for a `.d.ts` file. */
  readonly declaration: string;
  /** Content for a `.ts` file containing both the type and validator. */
  readonly module: string;
}

const TS_PRIMITIVES: Record<DhallPrimitive, string> = {
  Bool: "boolean",
  Natural: "number",
  Integer: "number",
  Double: "number",
  Text: "string",
  Bytes: "Uint8Array",
  Date: "string",
  Time: "string",
  TimeZone: "string",
};

interface PrimitiveValidator {
  expected: string;
  predicate: string;
}

const PRIMITIVE_VALIDATORS: Record<DhallPrimitive, PrimitiveValidator> = {
  Bool: { expected: "boolean", predicate: 'typeof candidate === "boolean"' },
  Natural: {
    expected: "non-negative integer",
    predicate: 'typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0',
  },
  Integer: {
    expected: "integer",
    predicate: 'typeof candidate === "number" && Number.isInteger(candidate)',
  },
  Double: { expected: "number", predicate: 'typeof candidate === "number"' },
  Text: { expected: "string", predicate: 'typeof candidate === "string"' },
  Bytes: { expected: "Uint8Array", predicate: "candidate instanceof Uint8Array" },
  Date: { expected: "date string", predicate: 'typeof candidate === "string"' },
  Time: { expected: "time string", predicate: 'typeof candidate === "string"' },
  TimeZone: { expected: "timezone string", predicate: 'typeof candidate === "string"' },
};

function toPascalCase(input: string): string {
  const parts = input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
  return /^[A-Za-z]/.test(name) ? name : `Dhall${name}`;
}

function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function renderKey(key: string): string {
  return isIdentifier(key) ? key : JSON.stringify(key);
}

function wrapUnion(type: string): string {
  return type.includes("|") ? `(${type})` : type;
}

function renderType(schema: DhallTypeSchema): string {
  switch (schema.kind) {
    case "primitive":
      return TS_PRIMITIVES[schema.name];
    case "list":
      return `${wrapUnion(renderType(schema.element))}[]`;
    case "optional":
      return `${wrapUnion(renderType(schema.element))} | null`;
    case "record": {
      const fields = Object.keys(schema.fields).map((key) => {
        return `  readonly ${renderKey(key)}: ${renderType(schema.fields[key]!)};`;
      });
      return `{\n${fields.join("\n")}\n}`;
    }
    case "union": {
      const alternatives = Object.keys(schema.alternatives).map((key) => {
        const value = schema.alternatives[key];
        if (value === null || value === undefined) {
          return `  | { readonly tag: ${JSON.stringify(key)} }`;
        }
        return `  | { readonly tag: ${JSON.stringify(key)}; readonly value: ${wrapUnion(renderType(value))} }`;
      });
      return alternatives.length === 0 ? "never" : `\n${alternatives.join("\n")}`;
    }
    case "map":
      return `Record<string, ${wrapUnion(renderType(schema.value))}>`;
    case "function":
      return "unknown";
  }
}

function renderDeclaration(name: string, schema: DhallTypeSchema): string {
  const body = renderType(schema);
  if (schema.kind === "record") {
    return `export interface ${name} ${body}\n`;
  }
  return `export type ${name} = ${body};\n`;
}

function indexedPath(base: string, suffix: string): string {
  return `${base} + "[" + ${suffix} + "]"`;
}

function renderValidatorExpression(
  schema: DhallTypeSchema,
  path: string,
  valueRef: string,
): string {
  switch (schema.kind) {
    case "primitive": {
      const validator = PRIMITIVE_VALIDATORS[schema.name];
      return `expect(${valueRef}, ${path}, ${JSON.stringify(validator.expected)}, candidate => ${validator.predicate})`;
    }
    case "list":
      return `expect(${valueRef}, ${path}, "array", Array.isArray).map((item, i) => ${renderValidatorExpression(schema.element, indexedPath(path, "i"), "item")})`;
    case "optional":
      return `${valueRef} === null ? null : ${renderValidatorExpression(schema.element, path, valueRef)}`;
    case "record": {
      const fields = Object.keys(schema.fields).map((key) => {
        const access = isIdentifier(key) ? `object.${key}` : `object[${JSON.stringify(key)}]`;
        const fieldPath = isIdentifier(key)
          ? `${path} + ".${key}"`
          : `${path} + "[" + ${JSON.stringify(key)} + "]"`;
        return `      ${renderKey(key)}: ${renderValidatorExpression(schema.fields[key]!, fieldPath, access)},`;
      });
      return `(() => {\n    const object = expectObject(${valueRef}, ${path});\n    return {\n${fields.join("\n")}\n    };\n  })()`;
    }
    case "union": {
      const cases = Object.keys(schema.alternatives).map((key) => {
        const value = schema.alternatives[key];
        const valueProperty =
          value === null || value === undefined
            ? ""
            : `, value: ${renderValidatorExpression(value, `${path} + ".value"`, "object.value")}`;
        return `      case ${JSON.stringify(key)}: return { tag${valueProperty} };`;
      });
      return `(() => {\n    const object = expectObject(${valueRef}, ${path});\n    switch (object.tag) {\n${cases.join("\n")}\n      default: return fail(${path}, "known tag", object.tag);\n    }\n  })()`;
    }
    case "map":
      return `Object.fromEntries(Object.entries(expectObject(${valueRef}, ${path})).map(([key, item]) => [key, ${renderValidatorExpression(schema.value, indexedPath(path, "key"), "item")}]))`;
    case "function":
      return `fail(${path}, "data value", ${valueRef})`;
  }
}

const VALIDATOR_HELPERS = `function fail(path: string, expected: string, value: unknown): never {
  throw new TypeError(\`\${path || "value"} expected \${expected}, got \${typeof value}\`);
}

function expect(
  value: unknown,
  path: string,
  expected: string,
  predicate: (candidate: unknown) => boolean,
): unknown {
  if (!predicate(value)) fail(path, expected, value);
  return value;
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  return expect(value, path, "object", candidate =>
    typeof candidate === "object" && candidate !== null,
  ) as Record<string, unknown>;
}
`;

/** Generate TypeScript declarations (and optionally validators) from a Dhall type schema. */
export function generateTypes(
  schema: DhallTypeSchema,
  options: GenerateTypesOptions,
): GeneratedTypes {
  const name = toPascalCase(options.name);
  const declaration = renderDeclaration(name, schema);

  if (!options.validator) {
    return { declaration, module: declaration };
  }

  const validatorName = `validate${name}`;
  const expression = renderValidatorExpression(schema, '"value"', "value");
  const validator = `export function ${validatorName}(value: unknown): ${name} {\n  return ${expression} as ${name};\n}\n`;

  return {
    declaration,
    module: `${declaration}\n${VALIDATOR_HELPERS}\n${validator}`,
  };
}
