import { basename } from "node:path";
import {
  command,
  flag,
  oneOf,
  option,
  optional,
  positional,
  runSafely,
  string,
  subcommands,
} from "cmd-ts";
import {
  DEFAULT_OUTPUT_FORMAT,
  OUTPUT_FORMATS,
  evaluateToText,
  formatDiagnostic,
  generateTypesFromSource,
  typeCheck,
  type DhallErrorKind,
  type Result,
} from "@dhall-wasm/core";
import { defaultIo, type CliIo } from "./io.ts";

export interface CliResult {
  readonly ok: boolean;
}

const sourceFile = positional({
  type: string,
  displayName: "file",
  description: "Dhall source file, or - to read stdin",
});

const formatType = oneOf(OUTPUT_FORMATS);

const remoteImportsFlag = flag({
  long: "remote-imports",
  description: "Allow HTTPS imports (disabled by default)",
});

async function execute<T>(
  io: CliIo,
  kind: DhallErrorKind,
  operation: () => Promise<Result<T>>,
  onSuccess: (value: T) => void,
): Promise<CliResult> {
  try {
    const result = await operation();
    if (!result.ok) {
      io.printError(formatDiagnostic(result.error));
      return { ok: false };
    }
    onSuccess(result.value);
    return { ok: true };
  } catch (error) {
    io.printError(
      formatDiagnostic({
        kind,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      }),
    );
    return { ok: false };
  }
}

/** Build the CLI from injected IO. The core library remains the only implementation. */
export function createApp(io: CliIo = defaultIo) {
  const evalCommand = command({
    name: "eval",
    description: "Evaluate a Dhall expression",
    args: {
      file: sourceFile,
      format: option({
        long: "format",
        short: "f",
        description: "Output format",
        type: formatType,
        defaultValue: () => DEFAULT_OUTPUT_FORMAT,
        defaultValueIsSerializable: true,
      }),
      remoteImports: remoteImportsFlag,
    },
    handler: async ({ file, format, remoteImports }) => {
      const source = await io.readSource(file);
      return execute(io, "evaluation", async () =>
        evaluateToText(source, {
          format,
          environment: io.createEnvironment(file, remoteImports),
          remoteImports,
        }), io.print);
    },
  });

  const typecheckCommand = command({
    name: "typecheck",
    description: "Type-check a Dhall expression",
    args: {
      file: sourceFile,
      remoteImports: remoteImportsFlag,
    },
    handler: async ({ file, remoteImports }) => {
      const source = await io.readSource(file);
      return execute(
        io,
        "typecheck",
        () =>
          typeCheck(source, {
            environment: io.createEnvironment(file, remoteImports),
            remoteImports,
          }),
        io.print,
      );
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
        description: "Generated TypeScript type name (defaults to the file name)",
        type: optional(string),
      }),
      out: option({
        long: "out",
        short: "o",
        description: "Output file (prints to stdout when omitted)",
        type: optional(string),
      }),
      validator: flag({
        long: "validator",
        description: "Include a runtime validator in the generated module",
      }),
      remoteImports: remoteImportsFlag,
    },
    handler: async ({ file, name, out, validator, remoteImports }) => {
      const source = await io.readSource(file);
      const typeName = name ?? basename(file, ".dhall");
      return execute(
        io,
        "unsupported",
        () =>
          generateTypesFromSource(source, {
            name: typeName,
            validator,
            environment: io.createEnvironment(file, remoteImports),
            remoteImports,
          }),
        (generated) =>
          validator ? io.printRaw(generated.module) : io.printRaw(generated.declaration),
      );
    },
  });

  return subcommands({
    name: "dhall-ts",
    version: "0.1.0",
    description: "Dhall for TypeScript projects",
    cmds: {
      eval: evalCommand,
      typecheck: typecheckCommand,
      types: typesCommand,
    },
  });
}

export const app = createApp();

/** Run the CLI without applying process effects; useful for in-process tests. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<CliResult> {
  const result = await runSafely(createApp(io), argv);
  if (result._tag !== "ok") return { ok: false };
  // `subcommands` wraps each handler's (async) return as `{ command, value }`.
  const wrapped = result.value as { value: Promise<CliResult> };
  return wrapped.value;
}
