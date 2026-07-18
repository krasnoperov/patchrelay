import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { StdioOptions } from "node:child_process";

const REDACTED_HEADER_NAMES = new Set(["authorization", "cookie", "set-cookie", "linear-signature"]);
const DIAGNOSTIC_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [redacted]"],
  [/\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|api[_-]?key|password|tokenEncryptionKey|bearerToken|secret)=([^\s&]+)/gi, "$1=[redacted]"],
  [/"(access_token|refresh_token|client_secret|accessToken|refreshToken|clientSecret|webhookSecret|apiKey|password|tokenEncryptionKey|bearerToken|secret)"\s*:\s*"[^"]*"/g, "\"$1\":\"[redacted]\""],
];

export function ensureAbsolutePath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export function timestampMsWithinSkew(timestampMs: number, maxSkewSeconds: number): boolean {
  return Math.abs(Date.now() - timestampMs) <= maxSkewSeconds * 1000;
}

export function verifyHmacSha256Hex(rawBody: Buffer, secret: string, providedHex: string): boolean {
  if (!providedHex) {
    return false;
  }

  const normalized = providedHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== 64) {
    return false;
  }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(normalized, "hex");

  return crypto.timingSafeEqual(expected, provided);
}

export function interpolateTemplate(input: string, context: Record<string, string>): string {
  return input.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => context[key] ?? "");
}

export function interpolateTemplateArray(input: string[], context: Record<string, string>): string[] {
  return input.map((value) => interpolateTemplate(value, context));
}

export async function execCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: StdioOptions;
    timeoutMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      // A hook commonly starts package-manager children. Put it in its own
      // process group so a watchdog can stop the whole hook rather than
      // leaving an orphaned install running in the worktree.
      detached: process.platform !== "win32",
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);

      resolve({
        stdout,
        stderr,
        exitCode: signal ? 1 : (code ?? 0),
      });
    });

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminateCommandProcessGroup(child, "SIGTERM");
        const forceKill = setTimeout(() => terminateCommandProcessGroup(child, "SIGKILL"), 1_000);
        forceKill.unref?.();
        reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`));
      }, options.timeoutMs);
      timeout.unref?.();
    }
  });
}

function terminateCommandProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      // The command may have already exited between the watchdog firing and
      // this signal. Fall back to the direct child when possible.
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
        child.kill(signal);
        return;
      }
    }
  }
  child.kill(signal);
}

export function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Exhaustiveness guard for discriminated-union switches (plan §D2): the call
 * only typechecks when every union member is handled, so adding a new variant
 * fails compilation at every consumer. At runtime it throws — reaching it
 * means a value outside the union leaked past a parse boundary.
 */
export function assertNever(value: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

export function redactSensitiveHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, REDACTED_HEADER_NAMES.has(name.toLowerCase()) ? "[redacted]" : value]),
  );
}

export function sanitizeDiagnosticText(text: string, maxLength = 500): string {
  let sanitized = text;
  for (const [pattern, replacement] of DIAGNOSTIC_REPLACEMENTS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  return `${sanitized.slice(0, Math.max(0, maxLength - 12))}[truncated]`;
}

export function encryptSecret(plaintext: string, keyMaterial: string): string {
  const key = crypto.createHash("sha256").update(keyMaterial).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

export function decryptSecret(payload: string, keyMaterial: string): string {
  const parsed = JSON.parse(payload) as { iv: string; tag: string; ciphertext: string };
  const key = crypto.createHash("sha256").update(keyMaterial).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }

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

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}
