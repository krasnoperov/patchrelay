import { useReducer, useMemo, useCallback, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
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

async function postPrompt(
  baseUrl: string,
  issueKey: string,
  text: string,
  bearerToken?: string,
): Promise<{ delivered?: boolean; queued?: boolean; reason?: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  try {
    const response = await fetch(new URL(`/api/issues/${encodeURIComponent(issueKey)}/prompt`, baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    return await response.json() as { delivered?: boolean; queued?: boolean; reason?: string };
  } catch {
    return { reason: "Request failed" };
  }
}

async function postStop(
  baseUrl: string,
  issueKey: string,
  bearerToken?: string,
): Promise<{ ok?: boolean; stopped?: boolean; reason?: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  try {
    const response = await fetch(new URL(`/api/issues/${encodeURIComponent(issueKey)}/stop`, baseUrl), {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json() as { ok?: boolean; stopped?: boolean; reason?: string };
    if (result.ok === undefined && result.stopped === true) {
      return { ...result, ok: true };
    }
    return result;
  } catch {
    return { reason: "request failed" };
  }
}

async function postRetry(baseUrl: string, issueKey: string, bearerToken?: string): Promise<{ ok?: boolean; reason?: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  try {
    const response = await fetch(new URL(`/api/issues/${encodeURIComponent(issueKey)}/retry`, baseUrl), {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return await response.json() as { ok?: boolean; reason?: string };
  } catch {
    return { reason: "request failed" };
  }
}

export function App({ baseUrl, bearerToken, initialIssueKey }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(watchReducer, {
    ...initialWatchState,
    ...(initialIssueKey ? { view: "detail" as const, activeDetailKey: initialIssueKey } : {}),
  });

  const filtered = useMemo(() => filterIssues(state.issues, state.filter), [state.issues, state.filter]);
  const [frozen, setFrozen] = useState(false);

  useWatchStream({ baseUrl, bearerToken, dispatch, active: !frozen });
  useDetailStream({ baseUrl, bearerToken, issueKey: state.activeDetailKey, dispatch, active: !frozen });
  useFeedStream({ baseUrl, bearerToken, active: state.view === "feed" && !frozen, dispatch });

  const [promptMode, setPromptMode] = useState(false);
  const [promptBuffer, setPromptBuffer] = useState("");

  const handleRetry = useCallback(() => {
    if (!state.activeDetailKey) return;
    setPromptStatus("retrying...");
    void postRetry(baseUrl, state.activeDetailKey, bearerToken).then((result) => {
      setPromptStatus(result.ok ? "retry queued" : `retry failed: ${result.reason ?? "unknown"}`);
      setTimeout(() => setPromptStatus(null), 3000);
    });
  }, [baseUrl, bearerToken, state.activeDetailKey]);

  const [promptStatus, setPromptStatus] = useState<string | null>(null);

  const handlePromptSubmit = useCallback(() => {
    const text = promptBuffer.trim();
    if (!state.activeDetailKey || !text) {
      setPromptMode(false);
      setPromptBuffer("");
      return;
    }

    // Add synthetic userMessage to timeline immediately
    dispatch({
      type: "codex-notification",
      method: "item/started",
      params: { item: { id: `prompt-${Date.now()}`, type: "userMessage", status: "completed", text } },
    });

    setPromptMode(false);
    setPromptBuffer("");
    setPromptStatus("sending...");

    void postPrompt(baseUrl, state.activeDetailKey, text, bearerToken).then((result) => {
      if (result.delivered) {
        setPromptStatus("delivered");
      } else if (result.queued) {
        setPromptStatus("queued for next run");
      } else if (result.reason) {
        setPromptStatus(`failed: ${result.reason}`);
      }
      setTimeout(() => setPromptStatus(null), 3000);
    });
  }, [baseUrl, bearerToken, state.activeDetailKey, promptBuffer]);

  useInput((input, key) => {
    if (promptMode) {
      if (key.escape) { setPromptMode(false); setPromptBuffer(""); }
      else if (key.return) { handlePromptSubmit(); }
      else if (key.backspace || key.delete) { setPromptBuffer((b) => b.slice(0, -1)); }
      else if (input && !key.ctrl && !key.meta) { setPromptBuffer((b) => b + input); }
      return;
    }

    if (input === "q") {
      exit();
      return;
    }
    if (input === "x") {
      setFrozen((value) => !value);
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
      } else if (input === "p") {
        setPromptMode(true);
      } else if (input === "s") {
        if (state.activeDetailKey) {
          setPromptStatus("stopping...");
          void postStop(baseUrl, state.activeDetailKey, bearerToken).then((result) => {
            setPromptStatus(result.ok ? "stop sent" : `stop failed: ${result.reason ?? "unknown"}`);
            setTimeout(() => setPromptStatus(null), 3000);
          });
        }
      } else if (input === "h") {
        dispatch({ type: "switch-detail-tab", tab: "history" });
      } else if (input === "t") {
        dispatch({ type: "switch-detail-tab", tab: "timeline" });
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
          lastServerMessageAt={state.lastServerMessageAt}
          filter={state.filter}
          totalCount={state.issues.length}
          frozen={frozen}
        />
      ) : state.view === "detail" ? (
        <Box flexDirection="column">
        {state.activeDetailKey && (
          <Box>
            <Text dimColor>Issues</Text>
            <Text dimColor> › </Text>
            <Text bold>{state.activeDetailKey}</Text>
            <Text dimColor> › </Text>
            <Text dimColor>{state.detailTab === "timeline" ? "Timeline" : "History"}</Text>
          </Box>
        )}
        <IssueDetailView
          issue={state.issues.find((i) => i.issueKey === state.activeDetailKey)}
          timeline={state.timeline}
          follow={state.follow}
          activeRunStartedAt={state.activeRunStartedAt}
          activeRunId={state.activeRunId}
          tokenUsage={state.tokenUsage}
          diffSummary={state.diffSummary}
          plan={state.plan}
          issueContext={state.issueContext}
          detailTab={state.detailTab}
          rawRuns={state.rawRuns}
          rawFeedEvents={state.rawFeedEvents}
          connected={state.connected}
          lastServerMessageAt={state.lastServerMessageAt}
        />
        {promptMode && (
          <Box>
            <Text color="yellow">prompt&gt; </Text>
            <Text>{promptBuffer}</Text>
            <Text dimColor>_</Text>
          </Box>
        )}
        {promptStatus && !promptMode && (
          <Text dimColor>{promptStatus}</Text>
        )}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Issues</Text>
            <Text dimColor> › </Text>
            <Text bold>Operator Feed</Text>
          </Box>
          <FeedView
            events={state.feedEvents}
            connected={state.connected}
            lastServerMessageAt={state.lastServerMessageAt}
          />
        </Box>
      )}
    </Box>
  );
}
