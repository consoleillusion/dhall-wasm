import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DhallEnvironment, ImportRequest } from "@dhall-wasm/core";

/** The CLI's default import resolver: local files, plus opt-in HTTPS. */
export function createNodeEnvironment(file: string, remoteImports: boolean): DhallEnvironment {
  const fallbackDirectory = file === "-" ? process.cwd() : dirname(resolve(file));

  const variables = Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]): Array<[string, string]> =>
      value === undefined ? [] : [[name, value]],
    ),
  );

  return {
    variables,
    async resolveImport(request: ImportRequest) {
      const specifier = request.specifier;
      const baseDirectory = request.baseDirectory || fallbackDirectory;

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
