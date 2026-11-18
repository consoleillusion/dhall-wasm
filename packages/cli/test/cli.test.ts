import { expect, test } from "bun:test";

test("CLI help lists the library-backed commands", async () => {
  const child = Bun.spawn(
    ["bun", "run", "packages/cli/src/main.ts", "--help"],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;

  expect(exitCode).toBe(0);
  expect(output).toContain("eval");
  expect(output).toContain("typecheck");
  expect(output).toContain("types");
});
