import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";

const REDACTED_HEADER_NAMES = new Set(["authorization", "cookie", "set-cookie", "linear-signature"]);

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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`));
      }, options.timeoutMs);
    }
  });
}

export function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function redactSensitiveHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, REDACTED_HEADER_NAMES.has(name.toLowerCase()) ? "[redacted]" : value]),
  );
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
