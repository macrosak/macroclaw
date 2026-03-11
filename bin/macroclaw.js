#!/usr/bin/env bun
if (typeof Bun === "undefined") {
  console.error("macroclaw requires Bun. Install it: https://bun.sh");
  process.exit(1);
}
await import("../src/index.ts");
