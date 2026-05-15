export const RECONCILIATION_GRACE_MS = 120_000;
export const DOWNSTREAM_STALE_MS = 900_000;

export type JsonObject = Record<string, unknown>;

export function safeJsonParse(value: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}
