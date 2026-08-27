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
  forceTerminateAfterMs?: number;
}): (trigger: string, exitCode?: number) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  let firstTrigger: string | undefined;
  let terminated = false;
  const terminate = options.terminate ?? ((code: number) => {
    process.exitCode = code;
    setImmediate(() => process.exit(code));
  });

  const terminateOnce = (code: number): void => {
    if (terminated) return;
    terminated = true;
    terminate(code);
  };

  return (trigger: string, exitCode?: number) => {
    if (shutdownPromise) {
      options.logger.warn(
        { service: options.service, trigger, firstTrigger },
        "Shutdown already in progress",
      );
      return shutdownPromise;
    }

    firstTrigger = trigger;
    options.logger.info({ service: options.service, trigger }, "Shutdown requested");
    const forcedTermination = exitCode !== undefined && options.forceTerminateAfterMs !== undefined
      ? setTimeout(() => {
        options.logger.error(
          { service: options.service, trigger, forceTerminateAfterMs: options.forceTerminateAfterMs },
          "Shutdown deadline exceeded; terminating",
        );
        terminateOnce(exitCode);
      }, options.forceTerminateAfterMs)
      : undefined;
    forcedTermination?.unref?.();
    shutdownPromise = options.cleanup()
      .then(() => {
        if (forcedTermination) clearTimeout(forcedTermination);
        options.logger.info({ service: options.service, trigger }, "Shutdown complete");
        if (exitCode !== undefined) {
          terminateOnce(exitCode);
        }
      })
      .catch((error: unknown) => {
        if (forcedTermination) clearTimeout(forcedTermination);
        options.logger.error(
          {
            service: options.service,
            trigger,
            error: error instanceof Error ? error.message : String(error),
          },
          "Shutdown failed",
        );
        terminateOnce(1);
      });
    return shutdownPromise;
  };
}
