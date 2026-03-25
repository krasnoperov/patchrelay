import type { OperatorFeedEvent } from "../../operator-feed.ts";

export interface WatchIssue {
  issueKey?: string | undefined;
  title?: string | undefined;
  projectId: string;
  factoryState: string;
  currentLinearState?: string | undefined;
  activeRunType?: string | undefined;
  latestRunType?: string | undefined;
  latestRunStatus?: string | undefined;
  prNumber?: number | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  updatedAt: string;
}

// ─── Thread / Turn / Item State ───────────────────────────────────

export interface WatchTurnItem {
  id: string;
  type: string;
  status: string;
  text?: string | undefined;        // agentMessage (accumulated from deltas)
  command?: string | undefined;      // commandExecution
  output?: string | undefined;       // command output (accumulated from deltas)
  exitCode?: number | undefined;
  durationMs?: number | undefined;
  changes?: unknown[] | undefined;   // fileChange
  toolName?: string | undefined;     // mcpToolCall / dynamicToolCall
}

export interface WatchTurn {
  id: string;
  status: string;
  items: WatchTurnItem[];
}

export interface WatchTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface WatchDiffSummary {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface WatchThread {
  threadId: string;
  status: string;
  turns: WatchTurn[];
  plan?: Array<{ step: string; status: string }> | undefined;
  diff?: string | undefined;
  diffSummary?: WatchDiffSummary | undefined;
  tokenUsage?: WatchTokenUsage | undefined;
}

// ─── Report (historical, for completed runs) ─────────────────────

export interface WatchReport {
  runType: string;
  status: string;
  summary?: string | undefined;
  commands: Array<{ command: string; exitCode?: number | undefined; durationMs?: number | undefined }>;
  fileChanges: number;
  toolCalls: number;
  assistantMessages: string[];
}

// ─── Top-level State ──────────────────────────────────────────────

export type WatchFilter = "all" | "active" | "non-done";

export interface WatchFeedEntry {
  at: string;
  kind: string;
  summary: string;
  status?: string | undefined;
  detail?: string | undefined;
}

export interface WatchState {
  connected: boolean;
  issues: WatchIssue[];
  selectedIndex: number;
  view: "list" | "detail";
  activeDetailKey: string | null;
  thread: WatchThread | null;
  report: WatchReport | null;
  filter: WatchFilter;
  follow: boolean;
  detailFeed: WatchFeedEntry[];
}

export type WatchAction =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "issues-snapshot"; issues: WatchIssue[] }
  | { type: "feed-event"; event: OperatorFeedEvent }
  | { type: "select"; index: number }
  | { type: "enter-detail"; issueKey: string }
  | { type: "exit-detail" }
  | { type: "thread-snapshot"; thread: WatchThread }
  | { type: "report-snapshot"; report: WatchReport }
  | { type: "codex-notification"; method: string; params: Record<string, unknown> }
  | { type: "cycle-filter" }
  | { type: "toggle-follow" };

export const initialWatchState: WatchState = {
  connected: false,
  issues: [],
  selectedIndex: 0,
  view: "list",
  activeDetailKey: null,
  thread: null,
  report: null,
  filter: "non-done",
  follow: true,
  detailFeed: [],
};

const TERMINAL_FACTORY_STATES = new Set(["done", "failed"]);

export function filterIssues(issues: WatchIssue[], filter: WatchFilter): WatchIssue[] {
  switch (filter) {
    case "all":
      return issues;
    case "active":
      return issues.filter((i) => i.activeRunType !== undefined);
    case "non-done":
      return issues.filter((i) => !TERMINAL_FACTORY_STATES.has(i.factoryState));
  }
}

function nextFilter(filter: WatchFilter): WatchFilter {
  switch (filter) {
    case "non-done": return "active";
    case "active": return "all";
    case "all": return "non-done";
  }
}

export function watchReducer(state: WatchState, action: WatchAction): WatchState {
  switch (action.type) {
    case "connected":
      return { ...state, connected: true };

    case "disconnected":
      return { ...state, connected: false };

    case "issues-snapshot":
      return {
        ...state,
        issues: action.issues,
        selectedIndex: Math.min(state.selectedIndex, Math.max(0, action.issues.length - 1)),
      };

    case "feed-event":
      return applyFeedEvent(state, action.event);

    case "select":
      return {
        ...state,
        selectedIndex: Math.max(0, Math.min(action.index, state.issues.length - 1)),
      };

    case "enter-detail":
      return { ...state, view: "detail", activeDetailKey: action.issueKey, thread: null, report: null, detailFeed: [] };

    case "exit-detail":
      return { ...state, view: "list", activeDetailKey: null, thread: null, report: null, detailFeed: [] };

    case "thread-snapshot":
      return { ...state, thread: action.thread };

    case "report-snapshot":
      return { ...state, report: action.report };

    case "codex-notification":
      return applyCodexNotification(state, action.method, action.params);

    case "cycle-filter":
      return { ...state, filter: nextFilter(state.filter), selectedIndex: 0 };

    case "toggle-follow":
      return { ...state, follow: !state.follow };
  }
}

// ─── Feed Event Application ───────────────────────────────────────

function applyFeedEvent(state: WatchState, event: OperatorFeedEvent): WatchState {
  if (!event.issueKey) {
    return state;
  }

  const index = state.issues.findIndex((issue) => issue.issueKey === event.issueKey);
  if (index === -1) {
    return state;
  }

  const updated = [...state.issues];
  const issue = { ...updated[index]! };

  if (event.kind === "stage" && event.stage) {
    issue.factoryState = event.stage;
  }
  if (event.kind === "stage" && event.status === "starting" && event.stage) {
    issue.activeRunType = event.stage;
  }
  if (event.kind === "turn") {
    if (event.status === "completed" || event.status === "failed") {
      issue.activeRunType = undefined;
      issue.latestRunStatus = event.status;
    }
  }
  if (event.kind === "github" && event.status) {
    if (event.status === "check_passed" || event.status === "check_failed") {
      issue.prCheckStatus = event.status === "check_passed" ? "passed" : "failed";
    }
  }

  issue.updatedAt = event.at;
  updated[index] = issue;

  // Append to detail feed if this event matches the active detail issue
  const detailFeed = state.view === "detail" && state.activeDetailKey === event.issueKey
    ? [...state.detailFeed, {
        at: event.at,
        kind: event.kind,
        summary: event.summary,
        ...(event.status ? { status: event.status } : {}),
        ...(event.detail ? { detail: event.detail } : {}),
      }]
    : state.detailFeed;

  return { ...state, issues: updated, detailFeed };
}

// ─── Codex Notification Application ───────────────────────────────

function applyCodexNotification(
  state: WatchState,
  method: string,
  params: Record<string, unknown>,
): WatchState {
  if (!state.thread) {
    // No thread loaded yet — only turn/started can bootstrap one
    if (method === "turn/started") {
      return bootstrapThreadFromTurnStarted(state, params);
    }
    return state;
  }

  switch (method) {
    case "turn/started":
      return withThread(state, addTurn(state.thread, params));
    case "turn/completed":
      return withThread(state, completeTurn(state.thread, params));
    case "turn/plan/updated":
      return withThread(state, updatePlan(state.thread, params));
    case "turn/diff/updated":
      return withThread(state, updateDiff(state.thread, params));
    case "item/started":
      return withThread(state, addItem(state.thread, params));
    case "item/completed":
      return withThread(state, completeItem(state.thread, params));
    case "item/agentMessage/delta":
      return withThread(state, appendItemText(state.thread, params));
    case "item/commandExecution/outputDelta":
      return withThread(state, appendItemOutput(state.thread, params));
    case "item/plan/delta":
      return withThread(state, appendItemText(state.thread, params));
    case "item/reasoning/summaryTextDelta":
      return withThread(state, appendItemText(state.thread, params));
    case "thread/status/changed":
      return withThread(state, updateThreadStatus(state.thread, params));
    case "thread/tokenUsage/updated":
      return withThread(state, updateTokenUsage(state.thread, params));
    default:
      return state;
  }
}

function withThread(state: WatchState, thread: WatchThread): WatchState {
  return { ...state, thread };
}

function bootstrapThreadFromTurnStarted(state: WatchState, params: Record<string, unknown>): WatchState {
  const turnObj = params.turn as Record<string, unknown> | undefined;
  const threadId = typeof params.threadId === "string" ? params.threadId : "unknown";
  const turnId = typeof turnObj?.id === "string" ? turnObj.id : "unknown";
  return {
    ...state,
    thread: {
      threadId,
      status: "active",
      turns: [{ id: turnId, status: "inProgress", items: [] }],
    },
  };
}

// ─── Turn Handlers ────────────────────────────────────────────────

function addTurn(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const turnObj = params.turn as Record<string, unknown> | undefined;
  const turnId = typeof turnObj?.id === "string" ? turnObj.id : "unknown";
  const existing = thread.turns.find((t) => t.id === turnId);
  if (existing) {
    return thread;
  }
  return {
    ...thread,
    status: "active",
    turns: [...thread.turns, { id: turnId, status: "inProgress", items: [] }],
  };
}

function completeTurn(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const turnObj = params.turn as Record<string, unknown> | undefined;
  const turnId = typeof turnObj?.id === "string" ? turnObj.id : undefined;
  const status = typeof turnObj?.status === "string" ? turnObj.status : "completed";
  if (!turnId) return thread;
  return {
    ...thread,
    turns: thread.turns.map((t) =>
      t.id === turnId ? { ...t, status } : t,
    ),
  };
}

function updatePlan(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const plan = params.plan;
  if (!Array.isArray(plan)) return thread;
  return {
    ...thread,
    plan: plan.map((entry) => {
      const e = entry as Record<string, unknown>;
      return {
        step: typeof e.step === "string" ? e.step : String(e.step ?? ""),
        status: typeof e.status === "string" ? e.status : "pending",
      };
    }),
  };
}

function updateDiff(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const diff = typeof params.diff === "string" ? params.diff : undefined;
  return { ...thread, diff, diffSummary: diff ? parseDiffSummary(diff) : undefined };
}

function parseDiffSummary(diff: string): WatchDiffSummary {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      files.add(line.slice(6));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { filesChanged: files.size, linesAdded: added, linesRemoved: removed };
}

function updateTokenUsage(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const usage = params.usage as Record<string, unknown> | undefined;
  if (!usage) return thread;
  const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens
    : typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens
    : typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return { ...thread, tokenUsage: { inputTokens, outputTokens } };
}

function updateThreadStatus(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const statusObj = params.status as Record<string, unknown> | undefined;
  const statusType = typeof statusObj?.type === "string" ? statusObj.type : undefined;
  if (!statusType) return thread;
  return { ...thread, status: statusType };
}

// ─── Item Handlers ────────────────────────────────────────────────

function getLatestTurn(thread: WatchThread): WatchTurn | undefined {
  return thread.turns[thread.turns.length - 1];
}

function updateLatestTurn(thread: WatchThread, updater: (turn: WatchTurn) => WatchTurn): WatchThread {
  const last = getLatestTurn(thread);
  if (!last) return thread;
  return {
    ...thread,
    turns: [...thread.turns.slice(0, -1), updater(last)],
  };
}

function addItem(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const itemObj = params.item as Record<string, unknown> | undefined;
  if (!itemObj) return thread;
  const id = typeof itemObj.id === "string" ? itemObj.id : "unknown";
  const type = typeof itemObj.type === "string" ? itemObj.type : "unknown";
  const status = typeof itemObj.status === "string" ? itemObj.status : "inProgress";

  const item: WatchTurnItem = { id, type, status };

  if (type === "agentMessage" && typeof itemObj.text === "string") {
    item.text = itemObj.text;
  }
  if (type === "commandExecution") {
    const cmd = itemObj.command;
    item.command = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : undefined;
  }
  if (type === "mcpToolCall") {
    const server = typeof itemObj.server === "string" ? itemObj.server : "";
    const tool = typeof itemObj.tool === "string" ? itemObj.tool : "";
    item.toolName = `${server}/${tool}`;
  }
  if (type === "dynamicToolCall") {
    item.toolName = typeof itemObj.tool === "string" ? itemObj.tool : undefined;
  }

  return updateLatestTurn(thread, (turn) => ({
    ...turn,
    items: [...turn.items, item],
  }));
}

function completeItem(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const itemObj = params.item as Record<string, unknown> | undefined;
  if (!itemObj) return thread;
  const id = typeof itemObj.id === "string" ? itemObj.id : undefined;
  if (!id) return thread;

  const status = typeof itemObj.status === "string" ? itemObj.status : "completed";
  const exitCode = typeof itemObj.exitCode === "number" ? itemObj.exitCode : undefined;
  const durationMs = typeof itemObj.durationMs === "number" ? itemObj.durationMs : undefined;
  const text = typeof itemObj.text === "string" ? itemObj.text : undefined;
  const changes = Array.isArray(itemObj.changes) ? itemObj.changes as unknown[] : undefined;

  return updateLatestTurn(thread, (turn) => ({
    ...turn,
    items: turn.items.map((item) => {
      if (item.id !== id) return item;
      return {
        ...item,
        status,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(changes !== undefined ? { changes } : {}),
      };
    }),
  }));
}

function appendItemText(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
  const delta = typeof params.delta === "string" ? params.delta : undefined;
  if (!itemId || !delta) return thread;

  return updateLatestTurn(thread, (turn) => ({
    ...turn,
    items: turn.items.map((item) =>
      item.id === itemId ? { ...item, text: (item.text ?? "") + delta } : item,
    ),
  }));
}

function appendItemOutput(thread: WatchThread, params: Record<string, unknown>): WatchThread {
  const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
  const delta = typeof params.delta === "string" ? params.delta : undefined;
  if (!itemId || !delta) return thread;

  return updateLatestTurn(thread, (turn) => ({
    ...turn,
    items: turn.items.map((item) =>
      item.id === itemId ? { ...item, output: (item.output ?? "") + delta } : item,
    ),
  }));
}
