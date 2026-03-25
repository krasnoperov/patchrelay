import { useEffect, useRef, type Dispatch } from "react";
import type { WatchAction } from "./watch-state.ts";
import type { TimelineRunInput } from "./timeline-builder.ts";
import type { OperatorFeedEvent } from "../../operator-feed.ts";
import type { CodexThreadSummary, StageReport } from "../../types.ts";

interface DetailStreamOptions {
  baseUrl: string;
  bearerToken?: string | undefined;
  issueKey: string | null;
  dispatch: Dispatch<WatchAction>;
}

export function useDetailStream(options: DetailStreamOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const { issueKey } = optionsRef.current;
    if (!issueKey) return;

    const abortController = new AbortController();
    const { baseUrl, bearerToken, dispatch } = optionsRef.current;

    const headers: Record<string, string> = {};
    if (bearerToken) {
      headers.authorization = `Bearer ${bearerToken}`;
    }

    // Rehydrate from timeline endpoint
    void rehydrate(baseUrl, issueKey, headers, abortController.signal, dispatch);

    // Stream codex notifications + feed events via filtered SSE
    void streamEvents(baseUrl, issueKey, headers, abortController.signal, dispatch);

    return () => {
      abortController.abort();
    };
  }, [options.issueKey]);
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
    const url = new URL(`/api/issues/${encodeURIComponent(issueKey)}/timeline`, baseUrl);
    const response = await fetch(url, { headers: { ...headers, accept: "application/json" }, signal });
    if (!response.ok) return;

    const data = await response.json() as {
      ok?: boolean;
      runs?: Array<{
        id: number;
        runType: string;
        status: string;
        startedAt: string;
        endedAt?: string;
        threadId?: string;
        report?: StageReport;
      }>;
      feedEvents?: OperatorFeedEvent[];
      liveThread?: CodexThreadSummary;
      activeRunId?: number;
    };

    const runs: TimelineRunInput[] = (data.runs ?? []).map((r) => ({
      id: r.id,
      runType: r.runType,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      threadId: r.threadId,
      ...(r.report ? { report: r.report } : {}),
    }));

    dispatch({
      type: "timeline-rehydrate",
      runs,
      feedEvents: data.feedEvents ?? [],
      liveThread: data.liveThread ?? null,
      activeRunId: data.activeRunId ?? null,
    });
  } catch {
    // Rehydration is best-effort
  }
}

// ─── Live SSE Stream ──────────────────────────────────────────────

async function streamEvents(
  baseUrl: string,
  issueKey: string,
  baseHeaders: Record<string, string>,
  signal: AbortSignal,
  dispatch: Dispatch<WatchAction>,
): Promise<void> {
  try {
    const url = new URL("/api/watch", baseUrl);
    url.searchParams.set("issue", issueKey);
    const headers = { ...baseHeaders, accept: "text/event-stream" };

    const response = await fetch(url, { headers, signal });
    if (!response.ok || !response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";
    let dataLines: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (!line) {
          if (dataLines.length > 0) {
            processEvent(dispatch, eventType, dataLines.join("\n"));
            dataLines = [];
            eventType = "";
          }
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith(":")) {
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } catch {
    // Stream ended or aborted
  }
}

function processEvent(dispatch: Dispatch<WatchAction>, eventType: string, data: string): void {
  try {
    if (eventType === "codex") {
      const parsed = JSON.parse(data) as { method: string; params: Record<string, unknown> };
      dispatch({ type: "codex-notification", method: parsed.method, params: parsed.params });
    }
    // Feed events are handled by the main watch stream
  } catch {
    // Ignore parse errors
  }
}
