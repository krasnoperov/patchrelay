import type { Output } from "./types.ts";
import { type UsageError } from "./types.ts";
import { helpTextFor } from "./help.ts";

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeOutput(stream: Output, text: string): void {
  stream.write(text);
}

export function writeUsageError(stream: Output, error: UsageError): void {
  writeOutput(stream, `${helpTextFor(error.helpTopic)}\n\nError: ${error.message}\n`);
}

export function normalizePublicBaseUrl(value: string): string {
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) ? value : `https://${value}`;
  return new URL(candidate).origin;
}
