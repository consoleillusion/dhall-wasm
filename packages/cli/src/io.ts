import { readFile, writeFile as writeFileFs } from "node:fs/promises";
import type { DhallEnvironment } from "@dhall-wasm/core";
import { createNodeEnvironment } from "./environment.ts";

/** All side effects the CLI uses, injected so library/CLI parity can be tested. */
export interface CliIo {
  readSource(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  print(line: string): void;
  printRaw(text: string): void;
  printError(line: string): void;
  createEnvironment(file: string, remoteImports: boolean): DhallEnvironment;
}

export const defaultIo: CliIo = {
  async readSource(path) {
    if (path === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    return readFile(path, "utf8");
  },

  async writeFile(path, content) {
    await writeFileFs(path, content, "utf8");
  },

  print(line) {
    console.log(line);
  },

  printRaw(text) {
    process.stdout.write(text);
  },

  printError(line) {
    console.error(line);
  },

  createEnvironment(file, remoteImports) {
    return createNodeEnvironment(file, remoteImports);
  },
};
