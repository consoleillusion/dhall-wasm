import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DhallEnvironment } from "@dhall-wasm/core";

/** The CLI's default import resolver: local files, plus opt-in HTTPS. */
export function createNodeEnvironment(file: string, remoteImports: boolean): DhallEnvironment {
  const baseDirectory = file === "-" ? process.cwd() : dirname(resolve(file));

  return {
    async resolveImport(request) {
      const specifier = request.specifier;

      if (/^https?:\/\//.test(specifier)) {
        if (!remoteImports) {
          throw new Error(
            `Remote import ${specifier} is disabled; pass --remote-imports to allow it`,
          );
        }
        const response = await fetch(specifier);
        if (!response.ok) {
          throw new Error(`Failed to fetch ${specifier}: ${response.status} ${response.statusText}`);
        }
        return { text: await response.text(), source: specifier };
      }

      if (specifier.startsWith("file://")) {
        const url = new URL(specifier);
        return { text: await readFile(url, "utf8"), source: url.pathname };
      }

      if (specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier)) {
        const path = isAbsolute(specifier) ? specifier : resolve(baseDirectory, specifier);
        return { text: await readFile(path, "utf8"), source: path };
      }

      throw new Error(`Unsupported import specifier: ${specifier}`);
    },
  };
}
