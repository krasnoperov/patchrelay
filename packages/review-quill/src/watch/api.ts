import type { ReviewAttemptDetail, ReviewQuillWatchSnapshot } from "../types.ts";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(readErrorMessage(body) ?? `Request failed: ${response.status}`);
  }
  return JSON.parse(body) as T;
}

function readErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: string; reason?: string; message?: string };
    return parsed.error ?? parsed.reason ?? parsed.message;
  } catch {
    return undefined;
  }
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export async function fetchSnapshot(baseUrl: string): Promise<ReviewQuillWatchSnapshot> {
  return await requestJson<ReviewQuillWatchSnapshot>(buildUrl(baseUrl, "/watch"));
}

export async function fetchAttemptDetail(baseUrl: string, attemptId: number): Promise<ReviewAttemptDetail> {
  return await requestJson<ReviewAttemptDetail>(buildUrl(baseUrl, `/attempts/${attemptId}`));
}

export async function triggerReconcile(baseUrl: string): Promise<{ ok: true; started: boolean }> {
  return await requestJson<{ ok: true; started: boolean }>(buildUrl(baseUrl, "/admin/reconcile"), { method: "POST" });
}
