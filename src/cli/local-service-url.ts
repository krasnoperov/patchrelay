import type { AppConfig } from "../types.ts";

export function normalizeLocalServiceHost(bind: string): string {
  if (bind === "0.0.0.0" || bind === "::" || bind === "127.0.0.1") {
    return "localhost";
  }
  if (bind === "::1") {
    return "[::1]";
  }
  if (bind.includes(":") && !bind.startsWith("[")) {
    return `[${bind}]`;
  }
  return bind;
}

export function localServiceBaseUrl(config: AppConfig): string {
  return `http://${normalizeLocalServiceHost(config.server.bind)}:${config.server.port}`;
}

export async function fetchLocalService(
  url: string,
  options?: { timeoutMs?: number; attempts?: number; retryDelayMs?: number },
): Promise<Response> {
  const attempts = Math.max(1, options?.attempts ?? 2);
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const retryDelayMs = options?.retryDelayMs ?? 100;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
