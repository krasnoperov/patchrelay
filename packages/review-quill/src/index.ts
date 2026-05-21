#!/usr/bin/env node

function installSqliteWarningFilter(): void {
  const emitWarning = process.emitWarning.bind(process);

  process.emitWarning = function filteredEmitWarning(
    warning: string | Error,
    optionsOrType?: NodeJS.EmitWarningOptions | string | Function,
    codeOrCtor?: string | Function,
    ctor?: Function,
  ): void {
    const type = typeof optionsOrType === "string"
      ? optionsOrType
      : typeof optionsOrType === "object"
        ? optionsOrType.type
        : warning instanceof Error
          ? warning.name
          : undefined;
    const message = warning instanceof Error ? warning.message : warning;

    if (type === "ExperimentalWarning" && message.includes("SQLite is an experimental feature")) {
      return;
    }

    if (typeof optionsOrType === "function") {
      emitWarning(warning, optionsOrType);
      return;
    }

    if (typeof optionsOrType === "object") {
      emitWarning(warning, optionsOrType);
      return;
    }

    if (typeof codeOrCtor === "function") {
      emitWarning(warning, optionsOrType, codeOrCtor);
      return;
    }

    emitWarning(warning, optionsOrType, codeOrCtor, ctor);
  };
}

installSqliteWarningFilter();

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
  const { runCli } = await import("./cli.ts");
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
