import { useEffect, useRef, type Dispatch } from "react";
import type { OperatorFeedEvent } from "../../operator-feed.ts";
import type { WatchAction } from "./watch-state.ts";

interface FeedStreamOptions {
  baseUrl: string;
  bearerToken?: string | undefined;
  active: boolean;
  dispatch: Dispatch<WatchAction>;
}

export function useFeedStream(options: FeedStreamOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!options.active) return;

    const abortController = new AbortController();
    const { baseUrl, bearerToken, dispatch } = optionsRef.current;

    void (async () => {
      try {
        const url = new URL("/api/feed", baseUrl);
        url.searchParams.set("follow", "1");
        url.searchParams.set("limit", "100");

        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

        const response = await fetch(url, { headers, signal: abortController.signal });
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventType = "";
        let dataLines: string[] = [];
        let initialBatch: OperatorFeedEvent[] = [];
        let snapshotSent = false;

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
              if (dataLines.length > 0 && eventType === "feed") {
                try {
                  const event = JSON.parse(dataLines.join("\n")) as OperatorFeedEvent;
                  if (!snapshotSent) {
                    initialBatch.push(event);
                  } else {
                    dispatch({ type: "feed-new-event", event });
                  }
                } catch { /* ignore parse errors */ }
                dataLines = [];
                eventType = "";
              }
              // After processing a batch of initial events, flush snapshot
              if (!snapshotSent && initialBatch.length > 0) {
                // Use a microtask to batch initial events
                const batch = initialBatch;
                initialBatch = [];
                snapshotSent = true;
                dispatch({ type: "feed-snapshot", events: batch });
              }
              newlineIndex = buffer.indexOf("\n");
              continue;
            }

            if (line.startsWith(":")) {
              // Keepalive or comment - flush initial batch if pending
              if (!snapshotSent && initialBatch.length > 0) {
                snapshotSent = true;
                dispatch({ type: "feed-snapshot", events: initialBatch });
                initialBatch = [];
              }
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
    })();

    return () => {
      abortController.abort();
    };
  }, [options.active]);
}
