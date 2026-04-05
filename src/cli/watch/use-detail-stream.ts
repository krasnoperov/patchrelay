import { useEffect, useRef, type Dispatch } from "react";
import type { WatchAction, WatchIssueContext } from "./watch-state.ts";
import type { CodexThreadSummary } from "../../types.ts";

interface DetailStreamOptions {
  baseUrl: string;
  bearerToken?: string | undefined;
  issueKey: string | null;
  active?: boolean | undefined;
  dispatch: Dispatch<WatchAction>;
}

export function useDetailStream(options: DetailStreamOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const { issueKey, active } = optionsRef.current;
    if (active === false) return;
    if (!issueKey) return;

    const abortController = new AbortController();
    const { baseUrl, bearerToken, dispatch } = optionsRef.current;

    const headers: Record<string, string> = {};
    if (bearerToken) {
      headers.authorization = `Bearer ${bearerToken}`;
    }

    void rehydrate(baseUrl, issueKey, headers, abortController.signal, dispatch);
    const intervalId = setInterval(() => {
      void rehydrate(baseUrl, issueKey, headers, abortController.signal, dispatch);
    }, 3000);

    return () => {
      clearInterval(intervalId);
      abortController.abort();
    };
  }, [options.issueKey, options.active]);
}

// ─── Rehydration ──────────────────────────────────────────────────

async function rehydrate(
  baseUrl: string,
  issueKey: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  dispatch: Dispatch<WatchAction>,
): Promise<void> {
  try {
    const url = new URL(`/api/issues/${encodeURIComponent(issueKey)}`, baseUrl);
    const response = await fetch(url, { headers: { ...headers, accept: "application/json" }, signal });
    if (!response.ok) return;

    const data = await response.json() as {
      ok?: boolean;
      issueContext?: WatchIssueContext;
      liveThread?: CodexThreadSummary;
      activeRun?: { id: number; startedAt?: string };
    };

    dispatch({
      type: "timeline-rehydrate",
      runs: [],
      feedEvents: [],
      liveThread: data.liveThread ?? null,
      activeRunId: data.activeRun?.id ?? null,
      activeRunStartedAt: data.activeRun?.startedAt ?? null,
      issueContext: data.issueContext ?? null,
    });
  } catch {
    // Rehydration is best-effort
  }
}
