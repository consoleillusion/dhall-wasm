import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  command,
  flag,
  oneOf,
  option,
  positional,
  string,
  subcommands,
} from "cmd-ts";
import {
  describeType,
  evaluate,
  generateTypes,
  typeCheck,
  type DhallDiagnostic,
  type OutputFormat,
} from "@dhall-wasm/core";

const sourceFile = positional({
  type: string,
  displayName: "file",
  description: "Dhall source file, or - to read stdin",
});

const format = oneOf(["json", "dhall", "cbor"] as const);

function report(error: DhallDiagnostic): void {
  const location = error.location
    ? ` (${error.source ?? "source"}:${error.location.line ?? error.location.start})`
    : "";
  console.error(`${error.kind}: ${error.message}${location}`);
  process.exitCode = 1;
}

async function readSource(path: string): Promise<string> {
  if (path === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(path, "utf8");
}

function printValue(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

const evalCommand = command({
  name: "eval",
  description: "Evaluate a Dhall expression",
  args: {
    file: sourceFile,
    format: option({
      long: "format",
      short: "f",
      description: "Output format",
      type: format,
      defaultValue: () => "json" as OutputFormat,
      defaultValueIsSerializable: true,
    }),
  },
  handler: async ({ file, format }) => {
    try {
      const result = await evaluate(await readSource(file), { format });
      if (!result.ok) {
        report(result.error);
        return;
      }
      printValue(result.value);
    } catch (error) {
      report({
        kind: "evaluation",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  },
});

const typecheckCommand = command({
  name: "typecheck",
  description: "Type-check a Dhall expression",
  args: { file: sourceFile },
  handler: async ({ file }) => {
    try {
      const result = await typeCheck(await readSource(file));
      if (!result.ok) {
        report(result.error);
        return;
      }
      console.log(result.value);
    } catch (error) {
      report({
        kind: "typecheck",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  },
});

const typesCommand = command({
  name: "types",
  description: "Generate TypeScript types from a Dhall type expression",
  args: {
    file: sourceFile,
    name: option({
      long: "name",
      short: "n",
      description: "Generated TypeScript type name",
      type: string,
    }),
    out: option({
      long: "out",
      short: "o",
      description: "Output file (prints to stdout when omitted)",
      type: string,
    }),
    validator: flag({
      long: "validator",
      description: "Include a runtime validator in the generated module",
    }),
  },
  handler: async ({ file, name, out, validator }) => {
    try {
      const source = await readSource(file);
      const described = await describeType(source);
      if (!described.ok) {
        report(described.error);
        return;
      }
      const typeName = name ?? basename(file, ".dhall");
      const generated = generateTypes(described.value, { name: typeName, validator });
      const content = validator ? generated.module : generated.declaration;
      if (out) {
        await writeFile(out, content, "utf8");
      } else {
        process.stdout.write(content);
      }
    } catch (error) {
      report({
        kind: "unsupported",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  },
});

export const app = subcommands({
  name: "dhall-ts",
  version: "0.1.0",
  description: "Dhall for TypeScript projects",
  cmds: {
    eval: evalCommand,
    typecheck: typecheckCommand,
    types: typesCommand,
  },
});
