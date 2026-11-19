#!/usr/bin/env bun
import { run } from "cmd-ts";
import { initializeEngine } from "@dhall-wasm/core";
import { app } from "./app.ts";

const argv = process.argv.slice(2);

if (argv.length === 0) {
  argv.push("--help");
}

await initializeEngine();

const result = await run(app, argv);
const outcome = await result.value;
process.exitCode = outcome.ok ? 0 : 1;
