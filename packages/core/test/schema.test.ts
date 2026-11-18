import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateTypes, type DhallTypeSchema } from "../src/index.ts";

const tempDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("generates a declaration from a record schema", () => {
  const schema: DhallTypeSchema = {
    kind: "record",
    fields: {
      name: { kind: "primitive", name: "Text" },
      age: { kind: "primitive", name: "Natural" },
    },
  };

  const generated = generateTypes(schema, { name: "config" });

  expect(generated.declaration).toContain("export interface Config");
  expect(generated.declaration).toContain("readonly name: string;");
  expect(generated.declaration).toContain("readonly age: number;");
});

test("generates a validator that rejects invalid values", async () => {
  const schema: DhallTypeSchema = {
    kind: "record",
    fields: {
      name: { kind: "primitive", name: "Text" },
      tags: { kind: "list", element: { kind: "primitive", name: "Text" } },
    },
  };
  const generated = generateTypes(schema, { name: "Config", validator: true });
  const directory = await mkdtemp(join(tmpdir(), "dhall-wasm-"));
  tempDirectories.push(directory);
  const file = join(directory, "config.ts");
  await Bun.write(file, generated.module);

  const module = (await import(pathToFileURL(file).href)) as {
    validateConfig(value: unknown): unknown;
  };

  expect(module.validateConfig({ name: "hi", tags: ["a"] })).toEqual({
    name: "hi",
    tags: ["a"],
  });
  expect(() => module.validateConfig({ name: "hi", tags: [1] })).toThrow(TypeError);
  expect(() => module.validateConfig({ name: 1, tags: [] })).toThrow(TypeError);
});
