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
  // Scan for the LAST top-level `{...}` block in the text. When the model
  // quotes the schema in a preamble and then emits its answer, the first
  // brace-matched block may be the schema example, not the actual answer.
  // Walking from the end finds the most recent brace-balanced region,
  // which is reliably the final answer.
  //
  // We still tolerate code fences, prose, and mixed quoting by relying on
  // the brace-depth walker rather than string parsing.
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return undefined;

  // Try from each `{` in turn (usually only one matters). Walk forward
  // tracking brace depth + string escapes. Return the LAST successful
  // balanced block — that's the one closest to the end of the message.
  let lastBalanced: string | undefined;
  for (let candidate = firstBrace; candidate !== -1; candidate = text.indexOf("{", candidate + 1)) {
    const balanced = walkJsonObject(text, candidate);
    if (balanced) lastBalanced = balanced;
  }
  return lastBalanced;
}

function walkJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

// Normalize common model malformations so `JSON.parse` can consume them.
// Covers the long tail we've seen in practice: markdown fences, trailing
// commas before `]`/`}`, line/block comments, smart quotes. Anything
// stranger falls through and `JSON.parse` throws.
export function sanitizeJsonPayload(raw: string): string {
  let cleaned = raw.trim();
  // Strip code fences like ```json\n...\n``` or ```\n...\n```
  cleaned = cleaned.replace(/^```(?:json|JSON)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  // Strip // line comments (only when they're the only thing on the line
  // or preceded by whitespace — don't touch URLs inside strings).
  cleaned = cleaned.replace(/(^|[\s,{[])\/\/[^\n]*/g, "$1");
  // Strip /* block comments */
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
  // Drop trailing commas before `}` or `]`
  cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");
  // Replace typographic quotes some models emit in prose-heavy outputs
  cleaned = cleaned.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'");
  return cleaned;
}

// Two-pass JSON parser: first try raw, then try after sanitization.
// Returns undefined if both attempts fail so callers can decide how
// to surface the error. Always prefer this over calling JSON.parse
// on model output directly.
export function forgivingJsonParse<T>(raw: string): T | undefined {
  const direct = safeJsonParse<T>(raw);
  if (direct !== undefined) return direct;
  const sanitized = sanitizeJsonPayload(raw);
  if (sanitized === raw) return undefined;
  return safeJsonParse<T>(sanitized);
}
