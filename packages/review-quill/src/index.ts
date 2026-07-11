#!/usr/bin/env node

import { handleStdoutError } from "./stdout-error.ts";

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

// A closed pipe is normal for short-lived CLI output (`diff | head`) but
// fatal for the daemon: a server that loses its service-owned stdout must
// exit non-zero so systemd can recover it and preserve an observable cause.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  handleStdoutError(error, process.argv[2]);
});

try {
  const { runCli } = await import("./cli.ts");
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
