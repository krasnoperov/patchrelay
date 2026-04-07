import { mkdir } from "node:fs/promises";
import path from "node:path";

const DIAGNOSTIC_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]"],
  [/\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|api[_-]?key|password|secret)=([^\s&]+)/gi, "$1=[redacted]"],
  [/"(access_token|refresh_token|client_secret|accessToken|refreshToken|clientSecret|webhookSecret|apiKey|password|secret)"\s*:\s*"[^"]*"/g, "\"$1\":\"[redacted]\""],
];

export function ensureAbsolutePath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function sanitizeDiagnosticText(text: string, maxLength = 500): string {
  let sanitized = text;
  for (const [pattern, replacement] of DIAGNOSTIC_REPLACEMENTS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maxLength - 12))}[truncated]`;
}

export function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}
