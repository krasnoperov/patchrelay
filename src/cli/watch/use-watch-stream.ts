import { useEffect, useRef, type Dispatch } from "react";
import type { OperatorFeedEvent } from "../../operator-feed.ts";
import type { WatchAction, WatchIssue } from "./watch-state.ts";

interface WatchStreamOptions {
  baseUrl: string;
  bearerToken?: string | undefined;
  issueFilter?: string | undefined;
  dispatch: Dispatch<WatchAction>;
}

export function useWatchStream(options: WatchStreamOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let abortController = new AbortController();
    let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = () => {
      abortController = new AbortController();
      const { baseUrl, bearerToken, issueFilter, dispatch } = optionsRef.current;

      const url = new URL("/api/watch", baseUrl);
      if (issueFilter) {
        url.searchParams.set("issue", issueFilter);
      }

      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (bearerToken) {
        headers.authorization = `Bearer ${bearerToken}`;
      }

      void fetch(url, { headers, signal: abortController.signal })
        .then(async (response) => {
          if (!response.ok || !response.body) {
            throw new Error(`Watch stream failed: ${response.status}`);
          }

          dispatch({ type: "connected" });
          attempt = 0;

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
                if (line.includes("keepalive")) {
                  dispatch({ type: "stream-heartbeat", receivedAt: Date.now() });
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
        })
        .catch((error) => {
          if (abortController.signal.aborted) return;
          const _msg = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          if (abortController.signal.aborted) return;
          dispatch({ type: "disconnected" });
          attempt = Math.min(attempt + 1, 5);
          const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
          reconnectTimeout = setTimeout(connect, delay);
        });
    };

    connect();

    return () => {
      abortController.abort();
      if (reconnectTimeout !== undefined) {
        clearTimeout(reconnectTimeout);
      }
    };
  }, []);
}

function processEvent(dispatch: Dispatch<WatchAction>, eventType: string, data: string): void {
  try {
    if (eventType === "issues") {
      const issues = JSON.parse(data) as WatchIssue[];
      dispatch({ type: "issues-snapshot", issues, receivedAt: Date.now() });
    } else if (eventType === "feed") {
      const event = JSON.parse(data) as OperatorFeedEvent;
      dispatch({ type: "feed-event", event, receivedAt: Date.now() });
    }
  } catch {
    // Ignore parse errors from malformed events
  }
}
