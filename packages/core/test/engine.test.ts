import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWasmEngine, type DhallEngine, type ImportRequest } from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function engine(): Promise<DhallEngine> {
  return loadWasmEngine();
}

test("the real WASM engine evaluates, type-checks, and describes expressions", async () => {
  const dhall = await engine();

  const evaluated = await dhall.evaluate('{ name = "Ada", count = 2 }', { format: "json" });
  expect(evaluated.ok).toBe(true);
  if (evaluated.ok) expect(evaluated.value).toEqual({ count: 2, name: "Ada" });

  const typed = await dhall.typeCheck("1");
  expect(typed.ok).toBe(true);
  if (typed.ok) expect(typed.value).toBe("Natural");

  const described = await dhall.describeType("{ name : Text, active : Bool } : Type");
  expect(described.ok).toBe(true);
  if (described.ok) {
    expect(described.value).toEqual({
      kind: "record",
      fields: {
        name: { kind: "primitive", name: "Text" },
        active: { kind: "primitive", name: "Bool" },
      },
    });
  }
});

test("the engine returns normalized Dhall text for the dhall format", async () => {
  const dhall = await engine();
  const result = await dhall.evaluate('{ name = "Ada", count = 2 }', { format: "dhall" });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe('{ count = 2, name = "Ada" }');
});

test("relative imports and env imports are resolved by the host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dhall-wasm-engine-"));
  temporaryDirectories.push(directory);

  const sourcePath = join(directory, "config.dhall");
  const source = 'let n = ./dep.dhall in { answer = n + 1, label = env:LABEL }';
  await writeFile(join(directory, "dep.dhall"), "41");
  await writeFile(sourcePath, source);

  const requests: ImportRequest[] = [];
  const environment = {
    variables: { LABEL: '"ok"' },
    async resolveImport(request: ImportRequest) {
      requests.push(request);
      const path = join(request.baseDirectory ?? directory, "dep.dhall");
      return { text: await Bun.file(path).text(), source: path };
    },
  };

  const dhall = await engine();
  const result = await dhall.evaluate(source, {
    format: "json",
    sourcePath,
    environment,
  });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toEqual({ answer: 42, label: "ok" });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.baseDirectory).toBe(directory);
});

test("engine diagnostics use core error kinds", async () => {
  const dhall = await engine();
  const result = await dhall.evaluate("1 +", { format: "json" });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.kind).toBe("parse");
    expect(result.error.message).toContain("unexpected");
  }
});
