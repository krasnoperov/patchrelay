#!/usr/bin/env node

import { runCli } from "./cli.ts";

// When the CLI is piped into something like `head` or `less -q`, the
// downstream consumer can close stdout before we finish writing. Node
// treats that as an unhandled error and crashes with EPIPE. Swallow it
// quietly — it's the normal outcome of `review-quill diff | head`, not
// a failure we should report.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
