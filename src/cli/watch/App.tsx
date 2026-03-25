import { useReducer, useMemo } from "react";
import { Box, useApp, useInput } from "ink";
import { watchReducer, initialWatchState, filterIssues } from "./watch-state.ts";
import { useWatchStream } from "./use-watch-stream.ts";
import { useDetailStream } from "./use-detail-stream.ts";
import { IssueListView } from "./IssueListView.tsx";
import { IssueDetailView } from "./IssueDetailView.tsx";

interface AppProps {
  baseUrl: string;
  bearerToken?: string | undefined;
  initialIssueKey?: string | undefined;
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
      }
    } else if (state.view === "detail") {
      if (key.escape || key.backspace || key.delete) {
        dispatch({ type: "exit-detail" });
      }
    }
  });

  return (
    <Box flexDirection="column">
      {state.view === "list" ? (
        <IssueListView issues={filtered} selectedIndex={state.selectedIndex} connected={state.connected} filter={state.filter} totalCount={state.issues.length} />
      ) : (
        <IssueDetailView
          issue={state.issues.find((i) => i.issueKey === state.activeDetailKey)}
          thread={state.thread}
          report={state.report}
        />
      )}
    </Box>
  );
}
