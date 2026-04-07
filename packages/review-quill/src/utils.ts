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
  // Walk forward through `{` positions and return the FIRST one that
  // produces a balanced top-level object. The walker tracks brace depth
  // and only returns at depth=0, so starting from the OUTERMOST `{` and
  // walking forward correctly returns the full top-level object even
  // when it contains nested arrays/objects (architectural_concerns[],
  // findings[], etc.).
  //
  // Earlier this function returned the LAST balanced block to defend
  // against a hypothetical "model echoes the schema in preamble" case.
  // That was wrong: with the rich schema, the LAST balanced block is
  // the LAST nested object (e.g. the last finding), not the top-level
  // verdict. The prompt explicitly forbids preamble before the JSON, so
  // returning the OUTERMOST first balanced block is both correct and
  // robust to nested schemas.
  //
  // The "walk forward through every `{`" loop also handles the rare
  // case where a malformed first attempt is followed by a valid second:
  // if `walkJsonObject` from the first `{` returns undefined (unbalanced),
  // we try the next `{`, and so on.
  let pos = text.indexOf("{");
  while (pos !== -1) {
    const balanced = walkJsonObject(text, pos);
    if (balanced) return balanced;
    pos = text.indexOf("{", pos + 1);
  }
  return undefined;
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
