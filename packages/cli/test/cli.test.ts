import { afterEach, expect, test } from "bun:test";
import {
  OUTPUT_FORMATS,
  clearEngine,
  evaluateToText,
  formatDiagnostic,
  generateTypesFromSource,
  setEngine,
  typeCheck,
  type DhallDiagnostic,
  type DhallEngine,
  type DhallTypeSchema,
} from "@dhall-wasm/core";
import { runCli } from "../src/app.ts";
import type { CliIo } from "../src/io.ts";

const schema: DhallTypeSchema = {
  kind: "record",
  fields: {
    name: { kind: "primitive", name: "Text" },
    count: { kind: "primitive", name: "Natural" },
  },
};

const workingEngine: DhallEngine = {
  async evaluate() {
    return { ok: true, value: { count: 2, name: "Ada" } };
  },
  async typeCheck() {
    return { ok: true, value: "{ count : Natural, name : Text }" };
  },
  async describeType() {
    return { ok: true, value: schema };
  },
};

function createTestIo(): CliIo & {
  out: string[];
  err: string[];
  files: Map<string, string>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();

  return {
    out,
    err,
    files,
    async readSource() {
      return "source";
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    print(line) {
      out.push(line);
    },
    printRaw(text) {
      out.push(text);
    },
    printError(line) {
      err.push(line);
    },
    createEnvironment() {
      return {
        async resolveImport() {
          throw new Error("imports are not used in parity tests");
        },
      };
    },
  };
}

afterEach(() => {
  clearEngine();
});

test("CLI help lists the library-backed commands", async () => {
  const child = Bun.spawn(["bun", "run", "packages/cli/src/main.ts", "--help"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;

  expect(exitCode).toBe(0);
  expect(output).toContain("eval");
  expect(output).toContain("typecheck");
  expect(output).toContain("types");
});

test("eval produces identical text through the library and the CLI for every format", async () => {
  setEngine(workingEngine);

  for (const format of OUTPUT_FORMATS) {
    const fromLibrary = await evaluateToText("source", { format });
    expect(fromLibrary.ok).toBe(true);
    if (!fromLibrary.ok) continue;

    const io = createTestIo();
    const result = await runCli(["eval", "config.dhall", "--format", format], io);

    expect(result.ok).toBe(true);
    expect(io.out.join("\n")).toBe(fromLibrary.value);
  }
});

test("typecheck produces identical text through the library and the CLI", async () => {
  setEngine(workingEngine);

  const fromLibrary = await typeCheck("source");
  expect(fromLibrary.ok).toBe(true);
  if (!fromLibrary.ok) return;

  const io = createTestIo();
  const result = await runCli(["typecheck", "config.dhall"], io);

  expect(result.ok).toBe(true);
  expect(io.out.join("\n")).toBe(fromLibrary.value);
});

test("types produces identical generated modules through the library and the CLI", async () => {
  setEngine(workingEngine);

  const fromLibrary = await generateTypesFromSource("source", {
    name: "Config",
    validator: true,
  });
  expect(fromLibrary.ok).toBe(true);
  if (!fromLibrary.ok) return;

  const io = createTestIo();
  const result = await runCli(
    ["types", "config.dhall", "--name", "Config", "--validator"],
    io,
  );

  expect(result.ok).toBe(true);
  expect(io.out.join("")).toBe(fromLibrary.value.module);
});

test("diagnostics are rendered identically through the library and the CLI", async () => {
  const diagnostic: DhallDiagnostic = {
    kind: "parse",
    message: "unexpected `}`",
    source: "config.dhall",
    location: { start: 5, line: 1, column: 6 },
  };
  setEngine({
    async evaluate() {
      return { ok: false, error: diagnostic };
    },
    async typeCheck() {
      return { ok: false, error: diagnostic };
    },
    async describeType() {
      return { ok: false, error: diagnostic };
    },
  });

  const io = createTestIo();
  const result = await runCli(["eval", "config.dhall"], io);

  expect(result.ok).toBe(false);
  expect(io.err.join("\n")).toBe(formatDiagnostic(diagnostic));
});
