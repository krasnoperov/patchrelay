export interface ShutdownLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export function createGracefulShutdown(options: {
  service: string;
  logger: ShutdownLogger;
  cleanup: () => Promise<void>;
  terminate?: (code: number) => void;
}): (trigger: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  let firstTrigger: string | undefined;
  const terminate = options.terminate ?? ((code: number) => {
    process.exitCode = code;
    setImmediate(() => process.exit(code));
  });

  return (trigger: string) => {
    if (shutdownPromise) {
      options.logger.warn(
        { service: options.service, trigger, firstTrigger },
        "Shutdown already in progress",
      );
      return shutdownPromise;
    }

    firstTrigger = trigger;
    options.logger.info({ service: options.service, trigger }, "Shutdown requested");
    shutdownPromise = options.cleanup()
      .then(() => {
        options.logger.info({ service: options.service, trigger }, "Shutdown complete");
      })
      .catch((error: unknown) => {
        options.logger.error(
          {
            service: options.service,
            trigger,
            error: error instanceof Error ? error.message : String(error),
          },
          "Shutdown failed",
        );
        terminate(1);
      });
    return shutdownPromise;
  };
}
