import { mkdirSync } from "node:fs";
import path from "node:path";
import pino, { type Logger, type LoggerOptions } from "pino";
import type { AppConfig } from "./types.js";

export function createLogger(config: AppConfig): Logger {
  const options: LoggerOptions = {
    level: config.logging.level,
    base: null,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  mkdirSync(path.dirname(config.logging.filePath), { recursive: true });

  const streams = pino.multistream([
    { stream: pino.destination(1) },
    {
      stream: pino.destination({
        dest: config.logging.filePath,
        sync: false,
        append: true,
      }),
    },
  ]);

  return pino(options, streams);
}
