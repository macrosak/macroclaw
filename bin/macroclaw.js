#!/usr/bin/env bun
if (typeof Bun === "undefined") {
  console.error("macroclaw requires Bun. Install it: https://bun.sh");
  process.exit(1);
}
const { runMain } = await import("citty");
const { main } = await import("../src/cli.ts");
await runMain(main);
