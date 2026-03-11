import { mkdirSync } from "node:fs";
import path from "node:path";
import pino, { type Logger, type LoggerOptions } from "pino";
import type { AppConfig } from "./types.ts";

export function createLogger(config: AppConfig): Logger {
  const options: LoggerOptions = {
    level: config.logging.level,
    base: null,
    redact: {
      paths: [
        "headers.authorization",
        "headers.cookie",
        "headers.set-cookie",
        "headers.linear-signature",
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.set-cookie",
        "req.headers.linear-signature",
        "authorization",
        "accessToken",
        "refreshToken",
        "access_token",
        "refresh_token",
        "clientSecret",
        "client_secret",
        "webhookSecret",
        "tokenEncryptionKey",
        "bearerToken",
        "accessTokenCiphertext",
        "refreshTokenCiphertext",
        "linear.webhookSecret",
        "linear.oauth.clientSecret",
        "operatorApi.bearerToken",
      ],
      censor: "[redacted]",
    },
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
