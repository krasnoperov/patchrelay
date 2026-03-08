import { mkdirSync } from "node:fs";
import path from "node:path";
import pino, { type Logger, type LoggerOptions } from "pino";
import type { AppConfig } from "./types.js";

export function createLogger(config: AppConfig): Logger {
  const options: LoggerOptions = {
    level: config.logging.level,
    base: null,
    transport: {
      targets: [
        {
          target: "pino-logfmt",
          options: buildLogfmtOptions(1),
        },
        {
          target: "pino-logfmt",
          options: buildLogfmtOptions(config.logging.filePath),
        },
      ],
    },
  };

  mkdirSync(path.dirname(config.logging.filePath), { recursive: true });

  return pino(options);
}

function buildLogfmtOptions(destination: number | string) {
  return {
    destination,
    flattenNestedObjects: true,
    flattenNestedSeparator: ".",
    includeLevelLabel: true,
    levelLabelKey: "level",
    formatTime: true,
    escapeMultilineStrings: true,
  };
}
