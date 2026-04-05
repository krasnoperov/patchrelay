import { useEffect, useRef, type Dispatch } from "react";
import type { WatchAction, WatchIssue } from "./watch-state.ts";

interface WatchStreamOptions {
  baseUrl: string;
  bearerToken?: string | undefined;
  issueFilter?: string | undefined;
  active?: boolean | undefined;
  dispatch: Dispatch<WatchAction>;
}

export function useWatchStream(options: WatchStreamOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (options.active === false) return;

    let abortController = new AbortController();

    const fetchIssueSnapshot = async () => {
      const { baseUrl, bearerToken, dispatch } = optionsRef.current;
      const headers: Record<string, string> = { accept: "application/json" };
      if (bearerToken) {
        headers.authorization = `Bearer ${bearerToken}`;
      }

      const response = await fetch(new URL("/api/issues", baseUrl), { headers, signal: abortController.signal });
      if (!response.ok) {
        throw new Error(`Issue snapshot failed: ${response.status}`);
      }

      const payload = await response.json() as { issues?: WatchIssue[] };
      dispatch({ type: "connected" });
      dispatch({ type: "issues-snapshot", issues: Array.isArray(payload.issues) ? payload.issues : [], receivedAt: Date.now() });
    };

    void fetchIssueSnapshot().catch(() => {
      if (!abortController.signal.aborted) {
        optionsRef.current.dispatch({ type: "disconnected" });
      }
    });
    const snapshotInterval = setInterval(() => {
      void fetchIssueSnapshot().catch(() => {
        if (!abortController.signal.aborted) {
          optionsRef.current.dispatch({ type: "disconnected" });
        }
      });
    }, 5000);

    return () => {
      abortController.abort();
      clearInterval(snapshotInterval);
    };
  }, [options.active]);
}
