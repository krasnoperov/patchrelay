#!/usr/bin/env node

function readFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  merge-steward serve [--config <path>]");
  console.log("  merge-steward watch [--config <path>] [--pr <number>]");
}

const command = process.argv[2];
const configPath = readFlag("--config");
const prFlag = readFlag("--pr");
const initialPrNumber = prFlag ? Number.parseInt(prFlag, 10) : undefined;

if (command === "serve") {
  const { startServer } = await import("./server.ts");
  await startServer(configPath);
} else if (command === "watch") {
  const { startWatch } = await import("./watch/index.tsx");
  await startWatch(configPath, Number.isFinite(initialPrNumber) ? initialPrNumber : undefined);
} else {
  printUsage();
  process.exitCode = 1;
}
