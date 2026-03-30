import type { QueueEntryDetail, QueueWatchSnapshot } from "../types.ts";

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

function buildUrl(baseUrl: string, path: string, params?: Record<string, string>): string {
  const base = baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export async function fetchSnapshot(baseUrl: string): Promise<QueueWatchSnapshot> {
  return await requestJson<QueueWatchSnapshot>(buildUrl(baseUrl, "/queue/watch", { eventLimit: "40" }));
}

export async function fetchEntryDetail(baseUrl: string, entryId: string): Promise<QueueEntryDetail> {
  return await requestJson<QueueEntryDetail>(buildUrl(baseUrl, `/queue/entries/${encodeURIComponent(entryId)}/detail`, { eventLimit: "120" }));
}

export async function triggerReconcile(baseUrl: string): Promise<{ ok: true; started: boolean }> {
  return await requestJson<{ ok: true; started: boolean }>(buildUrl(baseUrl, "/queue/reconcile"), { method: "POST" });
}

export async function dequeueEntry(baseUrl: string, entryId: string): Promise<void> {
  await requestJson<{ ok: true }>(buildUrl(baseUrl, `/queue/entries/${encodeURIComponent(entryId)}/dequeue`), { method: "POST" });
}
