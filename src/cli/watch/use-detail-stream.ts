import { useEffect, useRef, type Dispatch } from "react";
import type { WatchAction, WatchReport, WatchThread, WatchTurn, WatchTurnItem } from "./watch-state.ts";
import type { CodexThreadSummary, CodexThreadItem, StageReport } from "../../types.ts";

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

    const headers: Record<string, string> = { accept: "application/json" };
    if (bearerToken) {
      headers.authorization = `Bearer ${bearerToken}`;
    }

    // Rehydrate from thread/read via /api/issues/:key/live
    void rehydrate(baseUrl, issueKey, headers, abortController.signal, dispatch);

    // Stream codex notifications via filtered SSE
    void streamCodexEvents(baseUrl, issueKey, headers, abortController.signal, dispatch);

    return () => {
      abortController.abort();
    };
  }, [options.issueKey]);
}

async function rehydrate(
  baseUrl: string,
  issueKey: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  dispatch: Dispatch<WatchAction>,
): Promise<void> {
  try {
    const url = new URL(`/api/issues/${encodeURIComponent(issueKey)}/live`, baseUrl);
    const response = await fetch(url, { headers, signal });
    if (!response.ok) return;

    const data = await response.json() as {
      ok?: boolean;
      run?: { threadId?: string };
      live?: { threadId?: string; threadStatus?: string };
      thread?: CodexThreadSummary;
    };

    const threadData = data.thread;
    if (threadData) {
      dispatch({ type: "thread-snapshot", thread: materializeThread(threadData) });
      return;
    }

    // No active thread — fall back to latest run report
    await rehydrateFromReport(baseUrl, issueKey, headers, signal, dispatch);
  } catch {
    // Rehydration is best-effort — SSE stream will provide updates
  }
}

async function rehydrateFromReport(
  baseUrl: string,
  issueKey: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  dispatch: Dispatch<WatchAction>,
): Promise<void> {
  try {
    const url = new URL(`/api/issues/${encodeURIComponent(issueKey)}/report`, baseUrl);
    const response = await fetch(url, { headers, signal });
    if (!response.ok) return;

    const data = await response.json() as {
      ok?: boolean;
      runs?: Array<{ run: { runType: string; status: string }; report?: StageReport; summary?: Record<string, unknown> }>;
    };

    const latest = data.runs?.[0];
    if (!latest) return;

    const report: WatchReport = {
      runType: latest.run.runType,
      status: latest.run.status,
      summary: typeof latest.summary?.latestAssistantMessage === "string"
        ? latest.summary.latestAssistantMessage
        : latest.report?.assistantMessages.at(-1),
      commands: latest.report?.commands.map((c) => ({
        command: c.command,
        ...(typeof c.exitCode === "number" ? { exitCode: c.exitCode } : {}),
        ...(typeof c.durationMs === "number" ? { durationMs: c.durationMs } : {}),
      })) ?? [],
      fileChanges: latest.report?.fileChanges.length ?? 0,
      toolCalls: latest.report?.toolCalls.length ?? 0,
      assistantMessages: latest.report?.assistantMessages ?? [],
    };

    dispatch({ type: "report-snapshot", report });
  } catch {
    // Report fetch is best-effort
  }
}

async function streamCodexEvents(
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
            processDetailEvent(dispatch, eventType, dataLines.join("\n"));
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

function processDetailEvent(dispatch: Dispatch<WatchAction>, eventType: string, data: string): void {
  try {
    if (eventType === "codex") {
      const parsed = JSON.parse(data) as { method: string; params: Record<string, unknown> };
      dispatch({ type: "codex-notification", method: parsed.method, params: parsed.params });
    }
    // Feed events are already handled by the main watch stream
  } catch {
    // Ignore parse errors
  }
}

// ─── Thread Materialization from thread/read ──────────────────────

function materializeThread(summary: CodexThreadSummary): WatchThread {
  return {
    threadId: summary.id,
    status: summary.status,
    turns: summary.turns.map(materializeTurn),
  };
}

function materializeTurn(turn: { id: string; status: string; items: CodexThreadItem[] }): WatchTurn {
  return {
    id: turn.id,
    status: turn.status,
    items: turn.items.map(materializeItem),
  };
}

function materializeItem(item: CodexThreadItem): WatchTurnItem {
  // CodexThreadItem has an index-signature catch-all that defeats narrowing.
  // Access fields via Record<string, unknown> and coerce explicitly.
  const r = item as Record<string, unknown>;
  const id = String(r.id ?? "unknown");
  const type = String(r.type ?? "unknown");
  const base: WatchTurnItem = { id, type, status: "completed" };

  switch (type) {
    case "agentMessage":
      return { ...base, text: String(r.text ?? "") };
    case "commandExecution":
      return {
        ...base,
        command: String(r.command ?? ""),
        status: String(r.status ?? "completed"),
        ...(typeof r.exitCode === "number" ? { exitCode: r.exitCode } : {}),
        ...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
        ...(typeof r.aggregatedOutput === "string" ? { output: r.aggregatedOutput } : {}),
      };
    case "fileChange":
      return { ...base, status: String(r.status ?? "completed"), changes: Array.isArray(r.changes) ? r.changes as unknown[] : [] };
    case "mcpToolCall":
      return {
        ...base,
        status: String(r.status ?? "completed"),
        toolName: `${String(r.server ?? "")}/${String(r.tool ?? "")}`,
        ...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
      };
    case "dynamicToolCall":
      return {
        ...base,
        status: String(r.status ?? "completed"),
        toolName: String(r.tool ?? ""),
        ...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
      };
    case "plan":
      return { ...base, text: String(r.text ?? "") };
    case "reasoning":
      return { ...base, text: Array.isArray(r.summary) ? (r.summary as string[]).join("\n") : "" };
    default:
      return base;
  }
}
