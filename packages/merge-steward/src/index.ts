#!/usr/bin/env node

const command = process.argv[2];
const configArg = process.argv.indexOf("--config");
const configPath = configArg !== -1 ? process.argv[configArg + 1] : undefined;

if (command === "serve") {
  const { startServer } = await import("./server.ts");
  await startServer(configPath);
} else {
  console.log("Usage: merge-steward serve [--config <path>]");
  process.exitCode = 1;
}
