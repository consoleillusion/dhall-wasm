#!/usr/bin/env bun
import { run } from "cmd-ts";
import { app } from "./app.ts";

const argv = process.argv.slice(2);

if (argv.length === 0) {
  argv.push("--help");
}

await run(app, argv);
