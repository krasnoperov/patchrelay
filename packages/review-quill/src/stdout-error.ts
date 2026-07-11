export interface StdoutErrorActions {
  exit(code: number): never;
  writeStderr(message: string): void;
}

export function handleStdoutError(
  error: NodeJS.ErrnoException,
  command: string | undefined,
  actions: StdoutErrorActions = {
    exit: (code) => process.exit(code),
    writeStderr: (message) => process.stderr.write(message),
  },
): never {
  if (error.code !== "EPIPE") {
    throw error;
  }

  if (command !== "serve") {
    return actions.exit(0);
  }

  actions.writeStderr("review-quill serve lost its stdout stream (EPIPE); exiting for service recovery\n");
  return actions.exit(1);
}
