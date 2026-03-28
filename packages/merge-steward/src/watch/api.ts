import type { QueueEntryDetail, QueueWatchSnapshot } from "../types.ts";

async function requestJson<T>(url: URL, init?: RequestInit): Promise<T> {
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

export async function fetchSnapshot(baseUrl: string): Promise<QueueWatchSnapshot> {
  const url = new URL("/queue/watch", baseUrl);
  url.searchParams.set("eventLimit", "40");
  return await requestJson<QueueWatchSnapshot>(url);
}

export async function fetchEntryDetail(baseUrl: string, entryId: string): Promise<QueueEntryDetail> {
  const url = new URL(`/queue/entries/${encodeURIComponent(entryId)}/detail`, baseUrl);
  url.searchParams.set("eventLimit", "120");
  return await requestJson<QueueEntryDetail>(url);
}

export async function triggerReconcile(baseUrl: string): Promise<{ ok: true; started: boolean }> {
  const url = new URL("/queue/reconcile", baseUrl);
  return await requestJson<{ ok: true; started: boolean }>(url, { method: "POST" });
}

export async function dequeueEntry(baseUrl: string, entryId: string): Promise<void> {
  const url = new URL(`/queue/entries/${encodeURIComponent(entryId)}/dequeue`, baseUrl);
  await requestJson<{ ok: true }>(url, { method: "POST" });
}
