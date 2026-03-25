import { useReducer, useMemo, useCallback } from "react";
import { Box, useApp, useInput } from "ink";
import { watchReducer, initialWatchState, filterIssues } from "./watch-state.ts";
import { useWatchStream } from "./use-watch-stream.ts";
import { useDetailStream } from "./use-detail-stream.ts";
import { useFeedStream } from "./use-feed-stream.ts";
import { IssueListView } from "./IssueListView.tsx";
import { IssueDetailView } from "./IssueDetailView.tsx";
import { FeedView } from "./FeedView.tsx";

interface AppProps {
  baseUrl: string;
  bearerToken?: string | undefined;
  initialIssueKey?: string | undefined;
}

async function postRetry(baseUrl: string, issueKey: string, bearerToken?: string): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  await fetch(new URL(`/api/issues/${encodeURIComponent(issueKey)}/retry`, baseUrl), {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

export function App({ baseUrl, bearerToken, initialIssueKey }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(watchReducer, {
    ...initialWatchState,
    ...(initialIssueKey ? { view: "detail" as const, activeDetailKey: initialIssueKey } : {}),
  });

  const filtered = useMemo(() => filterIssues(state.issues, state.filter), [state.issues, state.filter]);

  useWatchStream({ baseUrl, bearerToken, dispatch });
  useDetailStream({ baseUrl, bearerToken, issueKey: state.activeDetailKey, dispatch });
  useFeedStream({ baseUrl, bearerToken, active: state.view === "feed", dispatch });

  const handleRetry = useCallback(() => {
    if (state.activeDetailKey) {
      void postRetry(baseUrl, state.activeDetailKey, bearerToken);
    }
  }, [baseUrl, bearerToken, state.activeDetailKey]);

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }

    if (state.view === "list") {
      if (input === "j" || key.downArrow) {
        dispatch({ type: "select", index: state.selectedIndex + 1 });
      } else if (input === "k" || key.upArrow) {
        dispatch({ type: "select", index: state.selectedIndex - 1 });
      } else if (key.return) {
        const issue = filtered[state.selectedIndex];
        if (issue?.issueKey) {
          dispatch({ type: "enter-detail", issueKey: issue.issueKey });
        }
      } else if (key.tab) {
        dispatch({ type: "cycle-filter" });
      } else if (input === "F" || input === "f") {
        dispatch({ type: "enter-feed" });
      }
    } else if (state.view === "detail") {
      if (key.escape || key.backspace || key.delete) {
        dispatch({ type: "exit-detail" });
      } else if (input === "f") {
        dispatch({ type: "toggle-follow" });
      } else if (input === "r") {
        handleRetry();
      } else if (input === "j" || key.downArrow) {
        dispatch({ type: "detail-navigate", direction: "next", filtered });
      } else if (input === "k" || key.upArrow) {
        dispatch({ type: "detail-navigate", direction: "prev", filtered });
      }
    } else if (state.view === "feed") {
      if (key.escape || key.backspace || key.delete) {
        dispatch({ type: "exit-feed" });
      }
    }
  });

  return (
    <Box flexDirection="column">
      {state.view === "list" ? (
        <IssueListView
          issues={filtered}
          allIssues={state.issues}
          selectedIndex={state.selectedIndex}
          connected={state.connected}
          filter={state.filter}
          totalCount={state.issues.length}
        />
      ) : state.view === "detail" ? (
        <IssueDetailView
          issue={state.issues.find((i) => i.issueKey === state.activeDetailKey)}
          timeline={state.timeline}
          follow={state.follow}
          activeRunStartedAt={state.activeRunStartedAt}
          tokenUsage={state.tokenUsage}
          diffSummary={state.diffSummary}
          plan={state.plan}
          issueContext={state.issueContext}
          allIssues={filtered}
          activeDetailKey={state.activeDetailKey}
        />
      ) : (
        <FeedView events={state.feedEvents} connected={state.connected} />
      )}
    </Box>
  );
}
