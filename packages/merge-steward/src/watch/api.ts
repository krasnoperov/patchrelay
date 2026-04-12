import type { QueueEntryDetail, QueueWatchSnapshot } from "../types.ts";

export interface GatewayHealthResponse {
  ok: boolean;
  repos: Array<{
    repoId: string;
    repoFullName: string;
  }>;
}

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

function repoBaseUrl(gatewayBaseUrl: string, repoId: string): string {
  const base = gatewayBaseUrl.replace(/\/$/, "");
  return `${base}/repos/${encodeURIComponent(repoId)}`;
}

export async function fetchSnapshot(gatewayBaseUrl: string, repoId: string): Promise<QueueWatchSnapshot> {
  return await requestJson<QueueWatchSnapshot>(buildUrl(repoBaseUrl(gatewayBaseUrl, repoId), "/queue/watch", { eventLimit: "40" }));
}

export async function fetchGatewayHealth(gatewayBaseUrl: string): Promise<GatewayHealthResponse> {
  return await requestJson<GatewayHealthResponse>(buildUrl(gatewayBaseUrl, "/health"));
}

export async function fetchEntryDetail(gatewayBaseUrl: string, repoId: string, entryId: string): Promise<QueueEntryDetail> {
  return await requestJson<QueueEntryDetail>(
    buildUrl(repoBaseUrl(gatewayBaseUrl, repoId), `/queue/entries/${encodeURIComponent(entryId)}/detail`, { eventLimit: "120" }),
  );
}

export async function triggerReconcile(gatewayBaseUrl: string, repoId: string): Promise<{ ok: true; started: boolean }> {
  return await requestJson<{ ok: true; started: boolean }>(buildUrl(repoBaseUrl(gatewayBaseUrl, repoId), "/queue/reconcile"), { method: "POST" });
}

export async function dequeueEntry(gatewayBaseUrl: string, repoId: string, entryId: string): Promise<void> {
  await requestJson<{ ok: true }>(
    buildUrl(repoBaseUrl(gatewayBaseUrl, repoId), `/queue/entries/${encodeURIComponent(entryId)}/dequeue`),
    { method: "POST" },
  );
}
