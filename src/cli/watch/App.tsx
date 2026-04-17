import { useReducer, useMemo, useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { watchReducer, initialWatchState, filterIssues } from "./watch-state.ts";
import { useWatchStream } from "./use-watch-stream.ts";
import { useDetailStream } from "./use-detail-stream.ts";
import { IssueListView } from "./IssueListView.tsx";
import { IssueDetailView } from "./IssueDetailView.tsx";
import { LogView } from "./LogView.tsx";
import {
  buildWatchDetailExportText,
  exportWatchTextToTempFile,
  findLastAssistantMessage,
  findLastCommand,
  findLastCommandOutput,
  openTextInPager,
  writeTextToClipboard,
} from "./watch-actions.ts";
import { measureRenderedTextRows } from "./layout-measure.ts";
import { PROMPT_COMPOSER_HINT, measurePromptComposerRows } from "./prompt-layout.ts";
import { clearTransientStatus, defaultTimerApi, setPersistentStatus, showTransientStatus } from "./transient-status.ts";

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
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(watchReducer, {
    ...initialWatchState,
    ...(initialIssueKey ? { view: "detail" as const, activeDetailKey: initialIssueKey } : {}),
  });

  const filtered = useMemo(() => filterIssues(state.issues, state.filter), [state.issues, state.filter]);
  const [frozen, setFrozen] = useState(false);
  const width = Math.max(20, stdout?.columns ?? 80);
  const compact = width < 90;

  useWatchStream({ baseUrl, bearerToken, dispatch, active: !frozen });
  useDetailStream({ baseUrl, bearerToken, issueKey: state.activeDetailKey, dispatch, active: !frozen });

  const [promptMode, setPromptMode] = useState(false);
  const [promptBuffer, setPromptBuffer] = useState("");
  const [promptCursor, setPromptCursor] = useState(0);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(null);
  const [promptDraftBeforeHistory, setPromptDraftBeforeHistory] = useState("");
  const [promptStatus, setPromptStatus] = useState<string | null>(null);
  const promptStatusController = useRef<{ timer: ReturnType<typeof setTimeout> | null }>({ timer: null });
  const activeIssue = state.issues.find((issue) => issue.issueKey === state.activeDetailKey);

  const showStatus = useCallback((message: string) => {
    showTransientStatus(promptStatusController.current, message, setPromptStatus, defaultTimerApi);
  }, []);
  const showPersistentStatus = useCallback((message: string) => {
    setPersistentStatus(promptStatusController.current, message, setPromptStatus, defaultTimerApi);
  }, []);

  useEffect(() => () => {
    clearTransientStatus(promptStatusController.current, defaultTimerApi);
  }, []);

  const resetPromptComposer = useCallback(() => {
    setPromptMode(false);
    setPromptBuffer("");
    setPromptCursor(0);
    setPromptHistoryIndex(null);
    setPromptDraftBeforeHistory("");
  }, []);

  const handleRetry = useCallback(() => {
    if (!state.activeDetailKey) return;
    showPersistentStatus("retrying...");
    void postRetry(baseUrl, state.activeDetailKey, bearerToken).then((result) => {
      showStatus(result.ok ? "retry queued" : `retry failed: ${result.reason ?? "unknown"}`);
    });
  }, [baseUrl, bearerToken, showPersistentStatus, showStatus, state.activeDetailKey]);

  const handlePromptSubmit = useCallback(() => {
    const text = promptBuffer.trim();
    if (!state.activeDetailKey || !text) {
      resetPromptComposer();
      return;
    }

    // Add synthetic userMessage to timeline immediately
    dispatch({
      type: "codex-notification",
      method: "item/started",
      params: { item: { id: `prompt-${Date.now()}`, type: "userMessage", status: "completed", text } },
    });

    setPromptHistory((history) => {
      const next = history.at(-1) === text ? history : [...history, text];
      return next.slice(-20);
    });
    resetPromptComposer();
    showPersistentStatus("sending...");

    void postPrompt(baseUrl, state.activeDetailKey, text, bearerToken).then((result) => {
      if (result.delivered) {
        showStatus("delivered");
      } else if (result.queued) {
        showStatus("queued for next run");
      } else if (result.reason) {
        showStatus(`failed: ${result.reason}`);
      }
    });
  }, [baseUrl, bearerToken, dispatch, promptBuffer, resetPromptComposer, showPersistentStatus, showStatus, state.activeDetailKey]);

  const withActiveIssueExport = useCallback(() => {
    if (!activeIssue) return null;
    return {
      issue: activeIssue,
      timeline: state.timeline,
      activeRunStartedAt: state.activeRunStartedAt,
      activeRunId: state.activeRunId,
      tokenUsage: state.tokenUsage,
      diffSummary: state.diffSummary,
      plan: state.plan,
      issueContext: state.issueContext,
      detailTab: state.detailTab,
      rawRuns: state.rawRuns,
      rawFeedEvents: state.rawFeedEvents,
    };
  }, [
    activeIssue,
    state.activeRunId,
    state.activeRunStartedAt,
    state.detailTab,
    state.diffSummary,
    state.issueContext,
    state.plan,
    state.rawFeedEvents,
    state.rawRuns,
    state.timeline,
    state.tokenUsage,
  ]);

  const handleCopyLastAssistant = useCallback(() => {
    const text = findLastAssistantMessage(state.timeline);
    if (!text) {
      showStatus("no assistant message to copy");
      return;
    }
    showStatus(writeTextToClipboard(text) ? "copied assistant message" : "clipboard unavailable");
  }, [showStatus, state.timeline]);

  const handleCopyLastCommand = useCallback(() => {
    const text = findLastCommand(state.timeline);
    if (!text) {
      showStatus("no command to copy");
      return;
    }
    showStatus(writeTextToClipboard(text) ? "copied last command" : "clipboard unavailable");
  }, [showStatus, state.timeline]);

  const handleCopyLastCommandOutput = useCallback(() => {
    const text = findLastCommandOutput(state.timeline);
    if (!text) {
      showStatus("no command output to copy");
      return;
    }
    showStatus(writeTextToClipboard(text) ? "copied command output" : "clipboard unavailable");
  }, [showStatus, state.timeline]);

  const handleExportTranscript = useCallback(() => {
    const exportInput = withActiveIssueExport();
    if (!exportInput) return;
    const text = buildWatchDetailExportText(exportInput);
    const filePath = exportWatchTextToTempFile(text, exportInput.issue.issueKey ?? exportInput.issue.projectId);
    showStatus(`exported transcript: ${filePath}`);
  }, [showStatus, withActiveIssueExport]);

  const handleOpenTranscriptInPager = useCallback(() => {
    const exportInput = withActiveIssueExport();
    if (!exportInput) return;
    const text = buildWatchDetailExportText(exportInput);
    const result = openTextInPager(text);
    if (result.ok) {
      showStatus("opened transcript in pager");
      return;
    }
    const filePath = exportWatchTextToTempFile(text, exportInput.issue.issueKey ?? exportInput.issue.projectId);
    showStatus(`pager failed, exported transcript: ${filePath}`);
  }, [showStatus, withActiveIssueExport]);

  const insertPromptText = useCallback((text: string) => {
    setPromptBuffer((buffer) => `${buffer.slice(0, promptCursor)}${text}${buffer.slice(promptCursor)}`);
    setPromptCursor((cursor) => cursor + text.length);
    setPromptHistoryIndex(null);
  }, [promptCursor]);

  const movePromptCursor = useCallback((delta: number) => {
    setPromptCursor((cursor) => Math.max(0, Math.min(promptBuffer.length, cursor + delta)));
  }, [promptBuffer.length]);

  const recallPromptHistory = useCallback((direction: "older" | "newer") => {
    if (promptHistory.length === 0) return;
    if (direction === "older") {
      if (promptHistoryIndex === null) {
        setPromptDraftBeforeHistory(promptBuffer);
        const nextIndex = promptHistory.length - 1;
        const next = promptHistory[nextIndex] ?? "";
        setPromptHistoryIndex(nextIndex);
        setPromptBuffer(next);
        setPromptCursor(next.length);
        return;
      }
      const nextIndex = Math.max(0, promptHistoryIndex - 1);
      const next = promptHistory[nextIndex] ?? "";
      setPromptHistoryIndex(nextIndex);
      setPromptBuffer(next);
      setPromptCursor(next.length);
      return;
    }

    if (promptHistoryIndex === null) return;
    if (promptHistoryIndex >= promptHistory.length - 1) {
      setPromptHistoryIndex(null);
      setPromptBuffer(promptDraftBeforeHistory);
      setPromptCursor(promptDraftBeforeHistory.length);
      return;
    }
    const nextIndex = promptHistoryIndex + 1;
    const next = promptHistory[nextIndex] ?? "";
    setPromptHistoryIndex(nextIndex);
    setPromptBuffer(next);
    setPromptCursor(next.length);
  }, [promptBuffer, promptDraftBeforeHistory, promptHistory, promptHistoryIndex]);

  useInput((input, key) => {
    if (promptMode) {
      if (key.escape) {
        resetPromptComposer();
      } else if (key.ctrl && input === "n") {
        insertPromptText("\n");
      } else if (key.return) {
        handlePromptSubmit();
      } else if (key.leftArrow) {
        movePromptCursor(-1);
      } else if (key.rightArrow) {
        movePromptCursor(1);
      } else if (key.home) {
        setPromptCursor(0);
      } else if (key.end) {
        setPromptCursor(promptBuffer.length);
      } else if (key.upArrow) {
        recallPromptHistory("older");
      } else if (key.downArrow) {
        recallPromptHistory("newer");
      } else if (key.backspace) {
        if (promptCursor > 0) {
          setPromptBuffer((buffer) => `${buffer.slice(0, promptCursor - 1)}${buffer.slice(promptCursor)}`);
          setPromptCursor((cursor) => Math.max(0, cursor - 1));
          setPromptHistoryIndex(null);
        }
      } else if (key.delete) {
        if (promptCursor < promptBuffer.length) {
          setPromptBuffer((buffer) => `${buffer.slice(0, promptCursor)}${buffer.slice(promptCursor + 1)}`);
          setPromptHistoryIndex(null);
        }
      } else if (input && !key.ctrl && !key.meta) {
        insertPromptText(input);
      }
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
      } else if (input === "a" || key.tab) {
        dispatch({ type: "cycle-filter" });
      }
      return;
    }

    if (state.view === "log") {
      if (key.escape || key.backspace || key.delete) {
        dispatch({ type: "exit-log" });
      } else if (input === "f") {
        dispatch({ type: "toggle-follow" });
      } else if (input === "y") {
        handleCopyLastAssistant();
      } else if (input === "c") {
        handleCopyLastCommand();
      } else if (input === "o") {
        handleCopyLastCommandOutput();
      } else if (input === "e") {
        handleExportTranscript();
      } else if (input === "v") {
        handleOpenTranscriptInPager();
      } else if (input === "j" || key.downArrow) {
        dispatch({ type: "detail-scroll", delta: 1 });
      } else if (input === "k" || key.upArrow) {
        dispatch({ type: "detail-scroll", delta: -1 });
      } else if (key.pageDown || (key.ctrl && input === "d")) {
        dispatch({ type: "detail-page", direction: "down" });
      } else if (key.pageUp || (key.ctrl && input === "u")) {
        dispatch({ type: "detail-page", direction: "up" });
      } else if (key.home) {
        dispatch({ type: "detail-jump", target: "start" });
      } else if (key.end) {
        dispatch({ type: "detail-jump", target: "end" });
      } else if (input === "[" || key.leftArrow) {
        dispatch({ type: "detail-navigate", direction: "prev", filtered });
      } else if (input === "]" || key.rightArrow) {
        dispatch({ type: "detail-navigate", direction: "next", filtered });
      }
      return;
    }

    // detail view
    if (key.escape || key.backspace || key.delete) {
      dispatch({ type: "exit-detail" });
    } else if (input === "l") {
      dispatch({ type: "enter-log" });
    } else if (input === "f") {
      dispatch({ type: "toggle-follow" });
    } else if (input === "r") {
      handleRetry();
    } else if (input === "p") {
      setPromptMode(true);
      setPromptCursor(promptBuffer.length);
    } else if (input === "s") {
      if (state.activeDetailKey) {
        showPersistentStatus("stopping...");
        void postStop(baseUrl, state.activeDetailKey, bearerToken).then((result) => {
          showStatus(result.ok ? "stop sent" : `stop failed: ${result.reason ?? "unknown"}`);
        });
      }
    } else if (input === "j" || key.downArrow) {
      dispatch({ type: "detail-scroll", delta: 1 });
    } else if (input === "k" || key.upArrow) {
      dispatch({ type: "detail-scroll", delta: -1 });
    } else if (key.pageDown || (key.ctrl && input === "d")) {
      dispatch({ type: "detail-page", direction: "down" });
    } else if (key.pageUp || (key.ctrl && input === "u")) {
      dispatch({ type: "detail-page", direction: "up" });
    } else if (key.home) {
      dispatch({ type: "detail-jump", target: "start" });
    } else if (key.end) {
      dispatch({ type: "detail-jump", target: "end" });
    } else if (input === "[" || key.leftArrow) {
      dispatch({ type: "detail-navigate", direction: "prev", filtered });
    } else if (input === "]" || key.rightArrow) {
      dispatch({ type: "detail-navigate", direction: "next", filtered });
    }
  });

  const reservedRows = 1 + (
    promptMode
      ? measurePromptComposerRows(promptBuffer, promptCursor, width)
      : promptStatus
        ? measureRenderedTextRows(promptStatus, width)
        : 0
  );

  return (
    <Box flexDirection="column">
      {state.view === "list" ? (
        <IssueListView
          issues={filtered}
          selectedIndex={state.selectedIndex}
          connected={state.connected}
          lastServerMessageAt={state.lastServerMessageAt}
          filter={state.filter}
          frozen={frozen}
          compact={compact}
        />
      ) : state.view === "log" ? (
        <LogView
          issue={activeIssue}
          timeline={state.timeline}
          follow={state.follow}
          scrollOffset={state.detailScrollOffset}
          activeRunId={state.activeRunId}
          reservedRows={reservedRows}
          onLayoutChange={(viewportRows, contentRows) => {
            dispatch({ type: "detail-layout-updated", viewportRows, contentRows });
          }}
        />
      ) : (
        <Box flexDirection="column">
          <IssueDetailView
            issue={activeIssue}
            timeline={state.timeline}
            follow={state.follow}
            scrollOffset={state.detailScrollOffset}
            unreadBelow={state.detailUnreadBelow}
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
            compact={compact}
            reservedRows={reservedRows}
            onLayoutChange={(viewportRows, contentRows) => {
              dispatch({ type: "detail-layout-updated", viewportRows, contentRows });
            }}
          />
          {promptMode && (
            <PromptComposer buffer={promptBuffer} cursor={promptCursor} />
          )}
          {promptStatus && !promptMode && (
            <Text dimColor>{promptStatus}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function PromptComposer({ buffer, cursor }: { buffer: string; cursor: number }): React.JSX.Element {
  const withCursor = `${buffer.slice(0, cursor)}|${buffer.slice(cursor)}`;
  const lines = withCursor.split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`prompt-line-${index}`}>
          <Text color="yellow">{index === 0 ? "prompt> " : "        "}</Text>
          <Text>{line}</Text>
        </Text>
      ))}
      <Text dimColor>{PROMPT_COMPOSER_HINT}</Text>
    </Box>
  );
}
