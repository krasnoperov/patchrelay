import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

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
    timeoutMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

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

