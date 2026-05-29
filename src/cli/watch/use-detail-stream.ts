import { useEffect, useRef, type Dispatch } from "react";
import type { WatchAction, WatchIssueContext } from "./watch-state.ts";
import type { CodexThreadSummary } from "../../types.ts";
import type { TimelineRunInput } from "./timeline-builder.ts";
import type { OperatorFeedEvent } from "../../operator-feed.ts";

const DETAIL_REHYDRATE_INTERVAL_MS = 3000;
const FEED_REHYDRATE_LIMIT = 100;
const MAX_CACHED_FEED_EVENTS = 300;

interface DetailStreamOptions {
  baseUrl: string;
  bearerToken?: string | undefined;
  issueKey: string | null;
  active?: boolean | undefined;
  dispatch: Dispatch<WatchAction>;
}

interface FeedRehydrateState {
  lastFeedEventId: number | undefined;
  feedEvents: OperatorFeedEvent[];
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

    const feedState: FeedRehydrateState = {
      lastFeedEventId: undefined,
      feedEvents: [],
    };
    let inFlight = false;

    const runRehydrate = () => {
      if (inFlight) return;
      inFlight = true;
      void rehydrate(baseUrl, issueKey, headers, abortController.signal, dispatch, feedState)
        .finally(() => {
          inFlight = false;
        });
    };

    runRehydrate();
    const intervalId = setInterval(() => {
      runRehydrate();
    }, DETAIL_REHYDRATE_INTERVAL_MS);

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
  feedState: FeedRehydrateState,
): Promise<void> {
  try {
    const url = new URL(`/api/issues/${encodeURIComponent(issueKey)}`, baseUrl);
    const feedUrl = buildFeedUrl(baseUrl, issueKey, feedState.lastFeedEventId);

    const [response, newFeedEvents] = await Promise.all([
      fetch(url, { headers: { ...headers, accept: "application/json" }, signal }),
      fetchFeedEvents(feedUrl, headers, signal),
    ]);
    if (!response.ok) return;
    updateFeedState(feedState, newFeedEvents);

    const data = await response.json() as {
      ok?: boolean;
      issueContext?: WatchIssueContext;
      liveThread?: CodexThreadSummary;
      runs?: TimelineRunInput[];
      activeRun?: { id: number; startedAt?: string };
    };

    dispatch({
      type: "timeline-rehydrate",
      runs: Array.isArray(data.runs) ? data.runs : [],
      feedEvents: feedState.feedEvents,
      liveThread: data.liveThread ?? null,
      activeRunId: data.activeRun?.id ?? null,
      activeRunStartedAt: data.activeRun?.startedAt ?? null,
      issueContext: data.issueContext ?? null,
    });
  } catch {
    // Rehydration is best-effort
  }
}

function buildFeedUrl(baseUrl: string, issueKey: string, afterId: number | undefined): URL {
  const feedUrl = new URL(`/api/issues/${encodeURIComponent(issueKey)}/feed`, baseUrl);
  feedUrl.searchParams.set("limit", String(FEED_REHYDRATE_LIMIT));
  if (afterId !== undefined) {
    feedUrl.searchParams.set("afterId", String(afterId));
  }
  return feedUrl;
}

async function fetchFeedEvents(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<OperatorFeedEvent[]> {
  try {
    const response = await fetch(url, { headers: { ...headers, accept: "application/json" }, signal });
    if (!response.ok) return [];
    const data = await response.json() as { events?: OperatorFeedEvent[] };
    return Array.isArray(data.events) ? data.events : [];
  } catch {
    return [];
  }
}

function updateFeedState(feedState: FeedRehydrateState, newEvents: OperatorFeedEvent[]): void {
  if (newEvents.length === 0) return;
  const byId = new Map<number, OperatorFeedEvent>();
  for (const event of feedState.feedEvents) {
    byId.set(event.id, event);
  }
  for (const event of newEvents) {
    byId.set(event.id, event);
  }
  const feedEvents = [...byId.values()]
    .sort((left, right) => left.id - right.id)
    .slice(-MAX_CACHED_FEED_EVENTS);
  feedState.feedEvents = feedEvents;
  feedState.lastFeedEventId = feedEvents.at(-1)?.id;
}
