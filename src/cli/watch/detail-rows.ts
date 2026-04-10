import type { OperatorFeedEvent, DetailTab, WatchDiffSummary, WatchIssue, WatchIssueContext, WatchTokenUsage } from "./watch-state.ts";
import type { TimelineEntry, TimelineRunInput } from "./timeline-builder.ts";
import { buildStateHistory, type HistoryRunInfo, type SideTripNode, type StateHistoryNode } from "./history-builder.ts";
import { buildTimelineRows } from "./timeline-presentation.ts";
import { planStepColor, planStepSymbol } from "./plan-helpers.ts";
import { progressBar } from "./format-utils.ts";
import {
  hasDisplayPrBlocker,
  isApprovedReviewState,
  isAwaitingReviewState,
  isChangesRequestedReviewState,
  isRereviewNeeded,
  prChecksFact,
} from "./pr-status.ts";
import { renderRichTextLines, renderTextLines, type TextLine, type TextSegment } from "./render-rich-text.ts";

interface BuildDetailLinesInput {
  issue: WatchIssue;
  timeline: TimelineEntry[];
  activeRunStartedAt: string | null;
  activeRunId: number | null;
  tokenUsage: WatchTokenUsage | null;
  diffSummary: WatchDiffSummary | null;
  plan: Array<{ step: string; status: string }> | null;
  issueContext: WatchIssueContext | null;
  detailTab: DetailTab;
  rawRuns: TimelineRunInput[];
  rawFeedEvents: OperatorFeedEvent[];
  width: number;
}

const SESSION_DISPLAY: Record<string, { label: string; color: string }> = {
  idle: { label: "idle", color: "blueBright" },
  running: { label: "running", color: "cyan" },
  waiting_input: { label: "needs input", color: "yellow" },
  done: { label: "done", color: "green" },
  failed: { label: "needs help", color: "red" },
};

const STAGE_DISPLAY: Record<string, string> = {
  blocked: "blocked",
  ready: "ready",
  delegated: "delegated",
  implementing: "implementing",
  completion_check: "completion check",
  pr_open: "PR open",
  changes_requested: "review changes",
  repairing_ci: "repairing CI",
  awaiting_queue: "waiting downstream",
  repairing_queue: "repairing queue",
  done: "merged",
  failed: "failed",
  escalated: "escalated",
  awaiting_input: "needs input",
};

const RUN_LABELS: Record<string, string> = {
  implementation: "implementation",
  ci_repair: "ci repair",
  review_fix: "review fix",
  branch_upkeep: "branch upkeep",
  queue_repair: "queue repair",
};

const STATE_LABELS: Record<string, string> = {
  delegated: "delegated",
  implementing: "implementing",
  pr_open: "pr open",
  changes_requested: "changes requested",
  repairing_ci: "repairing ci",
  awaiting_queue: "awaiting queue",
  repairing_queue: "repairing queue",
  awaiting_input: "awaiting input",
  escalated: "escalated",
  done: "done",
  failed: "failed",
};

export function buildDetailLines(input: BuildDetailLinesInput): TextLine[] {
  const width = Math.max(20, input.width);
  const lines: TextLine[] = [];
  const history = buildStateHistory(input.rawRuns, input.rawFeedEvents, input.issue.factoryState, input.activeRunId);

  lines.push(...buildHeaderLines(input, width));
  lines.push(blankLine("header-gap"));

  if (input.detailTab === "timeline") {
    lines.push(...buildPlanLines(input.plan, width));
    if (input.plan?.length) {
      lines.push(blankLine("plan-gap"));
    }
    lines.push(...buildTimelineLines(input.timeline, width));
  } else {
    lines.push(...buildHistoryIntroLines(width));
    lines.push(blankLine("history-intro-gap"));
    lines.push(...buildHistoryLines(history, input.plan, input.activeRunId, width));
  }

  return trimTrailingBlankLines(lines);
}

function buildHeaderLines(input: BuildDetailLinesInput, width: number): TextLine[] {
  const issue = input.issue;
  const session = sessionDisplay(issue);
  const stage = stageDisplay(issue);
  const facts = buildFactSegments(issue, input.issueContext);
  const meta = buildMeta(input.tokenUsage, input.diffSummary, input.issueContext);
  const headerSegments: TextSegment[] = [
    { text: issue.issueKey ?? issue.projectId, bold: true },
    { text: "  " },
    { text: session.label, color: session.color, bold: true },
    { text: "  ", dimColor: true },
    { text: stage, dimColor: true },
  ];

  if (facts.length > 0) {
    headerSegments.push({ text: "  ", dimColor: true });
    headerSegments.push(...joinFactSegments(facts));
  }
  if (meta.length > 0) {
    headerSegments.push({ text: "  ", dimColor: true });
    headerSegments.push({ text: meta.join("  "), dimColor: true });
  }

  const lines = renderTextLines(segmentsToText(headerSegments), {
    key: "detail-header",
    width,
  });
  lines[0] = { key: lines[0]!.key, segments: headerSegments };

  if (issue.title) {
    lines.push(...renderTextLines(issue.title, {
      key: "detail-title",
      width,
      style: { bold: true },
    }));
  }

  const blocker = blockerText(issue, input.issueContext);
  if (blocker) {
    lines.push(...renderTextLines(blocker, {
      key: "detail-blocker",
      width,
      style: { color: "yellow" },
    }));
  }

  if (issue.statusNote && issue.statusNote !== blocker) {
    lines.push(...renderRichTextLines(issue.statusNote, {
      key: "detail-note",
      width,
    }));
  }

  if (input.issueContext?.latestFailureSummary) {
    const failurePrefix = input.issueContext.latestFailureSource === "queue_eviction" ? "Queue failure: " : "Latest failure: ";
    const head = input.issueContext.latestFailureHeadSha ? ` @ ${input.issueContext.latestFailureHeadSha.slice(0, 8)}` : "";
    lines.push(...renderTextLines(`${failurePrefix}${input.issueContext.latestFailureSummary}${head}`, {
      key: "detail-failure",
      width,
      style: { color: input.issueContext.latestFailureSource === "queue_eviction" ? "yellow" : "red" },
    }));
  }

  return lines;
}

function buildPlanLines(plan: Array<{ step: string; status: string }> | null, width: number): TextLine[] {
  if (!plan || plan.length === 0) return [];
  const completed = plan.filter((step) => step.status === "completed").length;
  const lines = renderTextLines(`Plan  ${progressBar(completed, plan.length, 16)}  ${completed}/${plan.length}`, {
    key: "detail-plan-header",
    width,
    style: { dimColor: true },
  });
  for (const [index, entry] of plan.entries()) {
    lines.push({
      key: `detail-plan-${index}`,
      segments: [
        { text: `[${planStepSymbol(entry.status)}]`, color: planStepColor(entry.status) },
        { text: " " },
        { text: entry.step },
      ],
    });
  }
  return lines;
}

function buildTimelineLines(entries: TimelineEntry[], width: number): TextLine[] {
  const rows = buildTimelineRows(entries);
  if (rows.length === 0) {
    return renderTextLines("No timeline events yet.", {
      key: "timeline-empty",
      width,
      style: { dimColor: true },
    });
  }

  const lines: TextLine[] = [];
  for (const row of rows) {
    switch (row.kind) {
      case "feed":
        lines.push(...renderRichTextLines(`${feedGlyph(row.feed.status)} ${row.feed.summary}${row.repeatCount && row.repeatCount > 1 ? ` ×${row.repeatCount}` : ""}`, {
          key: row.id,
          width,
          style: { dimColor: true },
        }));
        break;
      case "ci-checks":
        lines.push(...renderTextLines(
          `● checks  ${row.ciChecks.checks.map((check) => `${check.status === "passed" ? "✓" : check.status === "failed" ? "✗" : "●"} ${check.name}`).join("  ")}`,
          {
            key: row.id,
            width,
            style: { color: row.ciChecks.overall === "failed" ? "red" : row.ciChecks.overall === "passed" ? "green" : "yellow", bold: true },
          },
        ));
        break;
      case "item":
        lines.push(...renderTimelineItemLines(row.id, row.item, width, 0));
        break;
      case "run":
        lines.push(...buildTimelineRunLines(row.id, row.run, row.items.map((item) => item.item), row.details, width));
        break;
    }
    lines.push(blankLine(`${row.id}-gap`));
  }

  return trimTrailingBlankLines(lines);
}

function buildTimelineRunLines(
  key: string,
  run: { runType: string; status: string; startedAt: string; endedAt?: string | undefined },
  items: Array<{ id: string; type: string; status: string; text?: string | undefined; command?: string | undefined; output?: string | undefined; exitCode?: number | undefined; durationMs?: number | undefined; changes?: unknown[] | undefined; toolName?: string | undefined }>,
  details: Array<{ tone: "message" | "command" | "meta" | "user"; text: string }>,
  width: number,
): TextLine[] {
  const statusColor = run.status === "completed" ? "green" : run.status === "failed" ? "red" : run.status === "running" ? "yellow" : "white";
  const headerText = `● ${RUN_LABELS[run.runType] ?? run.runType}  ${run.status}${run.endedAt ? `  ${formatDuration(run.startedAt, run.endedAt)}` : ""}`;
  const lines = renderTextLines(headerText, {
    key: `${key}-header`,
    width,
    style: { color: statusColor, bold: true },
  });

  const showVerboseItems = run.status === "running";
  if (showVerboseItems) {
    for (const item of items) {
      lines.push(...renderTimelineItemLines(`${key}-${item.id}`, item, width, 2));
    }
    return lines;
  }

  for (const [index, detail] of details.entries()) {
    if (detail.tone === "message" || detail.tone === "user") {
      lines.push(...renderRichTextLines(detail.tone === "user" ? `you: ${detail.text}` : detail.text, {
        key: `${key}-detail-${index}`,
        width,
        firstPrefix: [{ text: "  " }],
        continuationPrefix: [{ text: "  " }],
        style: { color: detail.tone === "user" ? "yellow" : undefined },
      }));
      continue;
    }
    lines.push(...renderTextLines(`${detail.tone === "command" ? "$ " : ""}${detail.text}`, {
      key: `${key}-detail-${index}`,
      width,
      firstPrefix: [{ text: "  " }],
      continuationPrefix: [{ text: "  " }],
      style: detail.tone === "command" ? { color: "white" } : { dimColor: true },
    }));
  }

  return lines;
}

function renderTimelineItemLines(
  key: string,
  item: { id: string; type: string; status: string; text?: string | undefined; command?: string | undefined; output?: string | undefined; exitCode?: number | undefined; durationMs?: number | undefined; changes?: unknown[] | undefined; toolName?: string | undefined },
  width: number,
  indent: number,
): TextLine[] {
  const prefix = [{ text: " ".repeat(indent) }];
  if (item.type === "agentMessage" || item.type === "userMessage" || item.type === "plan" || item.type === "reasoning") {
    return renderRichTextLines(item.type === "userMessage" ? `you: ${item.text ?? ""}` : item.text ?? "", {
      key,
      width,
      firstPrefix: prefix,
      continuationPrefix: prefix,
      style: item.type === "userMessage" ? { color: "yellow" } : undefined,
    });
  }

  const summary = itemSummary(item);
  const lines = renderTextLines(summary, {
    key,
    width,
    firstPrefix: prefix,
    continuationPrefix: prefix,
    style: item.status === "failed" || item.status === "declined"
      ? { color: "red" }
      : item.status === "inProgress"
        ? { color: "yellow" }
        : item.type === "commandExecution"
          ? { color: "white" }
          : { dimColor: item.type !== "commandExecution" },
  });

  if (item.output && item.type === "commandExecution") {
    lines.push(...renderTextLines(lastNonEmptyLine(item.output), {
      key: `${key}-output`,
      width,
      firstPrefix: [{ text: `${" ".repeat(indent + 2)}` }],
      continuationPrefix: [{ text: `${" ".repeat(indent + 2)}` }],
      style: { dimColor: true },
    }));
  }

  return lines;
}

function buildHistoryIntroLines(width: number): TextLine[] {
  return [
    ...renderTextLines("PatchRelay activity history.", {
      key: "history-intro-1",
      width,
      style: { dimColor: true },
    }),
    ...renderTextLines("Runs, waits, and wake-ups are shown here in PatchRelay order.", {
      key: "history-intro-2",
      width,
      style: { dimColor: true },
    }),
  ];
}

function buildHistoryLines(
  history: StateHistoryNode[],
  plan: Array<{ step: string; status: string }> | null,
  activeRunId: number | null,
  width: number,
): TextLine[] {
  if (history.length === 0) {
    return renderTextLines("No state history available.", {
      key: "history-empty",
      width,
      style: { dimColor: true },
    });
  }

  const lines: TextLine[] = [];
  let runCounter = 0;

  for (const [nodeIndex, node] of history.entries()) {
    lines.push(...renderTextLines(
      `${node.isCurrent ? "◉" : "○"} ${STATE_LABELS[node.state] ?? node.state}  ${formatTime(node.enteredAt)}`,
      {
        key: `history-node-${nodeIndex}`,
        width,
        style: { color: node.isCurrent ? "green" : undefined, bold: node.isCurrent },
      },
    ));
    if (node.reason) {
      lines.push(...renderRichTextLines(node.reason, {
        key: `history-node-${nodeIndex}-reason`,
        width,
        firstPrefix: [{ text: "│ ", dimColor: true }],
        continuationPrefix: [{ text: "│ ", dimColor: true }],
        style: { dimColor: true },
      }));
    }

    if (node.runs.length > 5) {
      lines.push(...renderTextLines(historyRunSummary(node.runs), {
        key: `history-node-${nodeIndex}-summary`,
        width,
        firstPrefix: [{ text: "│ ", dimColor: true }],
        continuationPrefix: [{ text: "│ ", dimColor: true }],
        style: { dimColor: true },
      }));
    }

    for (const run of node.runs) {
      lines.push(...renderHistoryRunLines(run, runCounter, width, "│ "));
      if (run.id === activeRunId && plan?.length) {
        for (const [index, entry] of plan.entries()) {
          lines.push({
            key: `history-run-${run.id}-plan-${index}`,
            segments: [
              { text: "│   ", dimColor: true },
              { text: `[${planStepSymbol(entry.status)}]`, color: planStepColor(entry.status) },
              { text: " " },
              { text: entry.step },
            ],
          });
        }
      }
      runCounter += 1;
    }

    for (const [tripIndex, trip] of node.sideTrips.entries()) {
      lines.push(...renderSideTripLines(trip, runCounter, width));
      runCounter += trip.runs.length;
      if (tripIndex < node.sideTrips.length - 1) {
        lines.push({ key: `history-trip-gap-${nodeIndex}-${tripIndex}`, segments: [{ text: "│", dimColor: true }] });
      }
    }

    if (nodeIndex < history.length - 1) {
      lines.push({ key: `history-node-connector-${nodeIndex}`, segments: [{ text: "│", dimColor: true }] });
    }
  }

  return lines;
}

function renderHistoryRunLines(run: HistoryRunInfo, index: number, width: number, gutter: string): TextLine[] {
  const statusColor = run.status === "completed" ? "green" : run.status === "failed" ? "red" : run.status === "running" ? "yellow" : "white";
  const duration = run.endedAt ? formatDuration(run.startedAt, run.endedAt) : undefined;
  const stats = [
    run.messageCount !== undefined ? `${run.messageCount} msgs` : null,
    run.commandCount ? `${run.commandCount} cmds` : null,
    run.fileChangeCount ? `${run.fileChangeCount} files` : null,
  ].filter((value): value is string => Boolean(value));
  const lines = renderTextLines(
    `${gutter}${run.status === "completed" ? "✓" : run.status === "failed" ? "✗" : run.status === "running" ? "▸" : "•"} #${index + 1} (${RUN_LABELS[run.runType] ?? run.runType})${duration ? ` ${duration}` : ""}${stats.length ? `  ${stats.join(", ")}` : ""}`,
    {
      key: `history-run-${run.id}`,
      width,
      style: { color: statusColor },
    },
  );

  if (run.lastMessage) {
    lines.push(...renderRichTextLines(run.lastMessage, {
      key: `history-run-${run.id}-message`,
      width,
      firstPrefix: [{ text: `${gutter}  `, dimColor: true }],
      continuationPrefix: [{ text: `${gutter}  `, dimColor: true }],
      style: { dimColor: true },
    }));
  }

  return lines;
}

function renderSideTripLines(trip: SideTripNode, runOffset: number, width: number): TextLine[] {
  const lines = renderTextLines(`│ ┌ ${STATE_LABELS[trip.state] ?? trip.state}  ${formatTime(trip.enteredAt)}`, {
    key: `history-trip-${trip.state}-${trip.enteredAt}`,
    width,
    style: { color: "magenta", bold: true },
  });
  if (trip.reason) {
    lines.push(...renderRichTextLines(trip.reason, {
      key: `history-trip-${trip.state}-${trip.enteredAt}-reason`,
      width,
      firstPrefix: [{ text: "│ │ ", dimColor: true }],
      continuationPrefix: [{ text: "│ │ ", dimColor: true }],
      style: { dimColor: true },
    }));
  }
  for (const [index, run] of trip.runs.entries()) {
    lines.push(...renderHistoryRunLines(run, runOffset + index, width, "│ │ "));
  }
  const returnLabel = trip.returnedAt
    ? `│ └→ ${STATE_LABELS[trip.returnState] ?? trip.returnState}  ${formatTime(trip.returnedAt)}`
    : "│ └─ (active)";
  lines.push(...renderTextLines(returnLabel, {
    key: `history-trip-${trip.state}-${trip.enteredAt}-return`,
    width,
    style: { dimColor: !trip.returnedAt },
  }));
  return lines;
}

function buildFactSegments(issue: WatchIssue, issueContext: WatchIssueContext | null): TextSegment[][] {
  const facts: TextSegment[][] = [];
  const rereviewNeeded = isRereviewNeeded(issue);
  if (issue.prNumber !== undefined) facts.push([{ text: `PR #${issue.prNumber}`, color: "cyan" }]);
  if (isApprovedReviewState(issue.prReviewState)) facts.push([{ text: "approved", color: "green" }]);
  else if (rereviewNeeded) facts.push([{ text: "re-review needed", color: "yellow" }]);
  else if (isChangesRequestedReviewState(issue.prReviewState)) facts.push([{ text: "changes requested", color: "yellow" }]);
  else if (
    issue.prNumber !== undefined
    && (isAwaitingReviewState(issue.prReviewState) || (!issue.prReviewState && issue.factoryState === "pr_open"))
  ) facts.push([{ text: "awaiting review", color: "yellow" }]);
  if (issue.factoryState === "awaiting_queue") facts.push([{ text: "merge queue", color: "cyan" }]);
  if (issue.waitingReason && issue.sessionState === "waiting_input") facts.push([{ text: issue.waitingReason, color: "yellow" }]);
  const checks = prChecksFact({
    ...issue,
    latestFailureCheckName: issueContext?.latestFailureCheckName ?? issue.latestFailureCheckName,
  });
  if (checks) {
    facts.push([{ text: checks.text, color: checks.color }]);
  }
  return facts;
}

function joinFactSegments(facts: TextSegment[][]): TextSegment[] {
  const segments: TextSegment[] = [];
  for (const [index, fact] of facts.entries()) {
    if (index > 0) {
      segments.push({ text: " · ", dimColor: true });
    }
    segments.push(...fact);
  }
  return segments;
}

function buildMeta(
  tokenUsage: WatchTokenUsage | null,
  diffSummary: WatchDiffSummary | null,
  issueContext: WatchIssueContext | null,
): string[] {
  const meta: string[] = [];
  if (tokenUsage) meta.push(`${formatTokens(tokenUsage.inputTokens)} in / ${formatTokens(tokenUsage.outputTokens)} out`);
  if (diffSummary && diffSummary.filesChanged > 0) meta.push(`${diffSummary.filesChanged}f +${diffSummary.linesAdded} -${diffSummary.linesRemoved}`);
  if (issueContext?.runCount) meta.push(`${issueContext.runCount} runs`);
  return meta;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder > 0 ? ` ${String(remainder).padStart(2, "0")}s` : ""}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function itemSummary(item: { type: string; text?: string | undefined; command?: string | undefined; exitCode?: number | undefined; durationMs?: number | undefined; changes?: unknown[] | undefined; toolName?: string | undefined }): string {
  switch (item.type) {
    case "commandExecution": {
      const exit = item.exitCode !== undefined && item.exitCode !== 0 ? `  exit ${item.exitCode}` : "";
      const duration = item.durationMs && item.durationMs >= 1000 ? `  ${Math.floor(item.durationMs / 1000)}s` : "";
      return `$ ${cleanCommand(item.command ?? "?")}${exit}${duration}`;
    }
    case "fileChange":
      return summarizeFileChanges(item.changes ?? []);
    case "mcpToolCall":
    case "dynamicToolCall":
      return `used ${item.toolName ?? item.type}`;
    default:
      return (item.text ?? item.type).replace(/\s+/g, " ").trim();
  }
}

function summarizeFileChanges(changes: unknown[]): string {
  const files = Array.from(new Set(
    changes
      .map((change) => {
        if (!change || typeof change !== "object") return undefined;
        const path = (change as Record<string, unknown>).path;
        return typeof path === "string" && path.trim().length > 0 ? path : undefined;
      })
      .filter((path): path is string => Boolean(path)),
  ));

  if (files.length === 0) {
    return `updated ${changes.length} file${changes.length === 1 ? "" : "s"}`;
  }

  const names = files.map((path) => path.split("/").at(-1) ?? path);
  return `updated ${files.length} file${files.length === 1 ? "" : "s"}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`;
}

function sessionDisplay(issue: WatchIssue): { label: string; color: string } {
  if (issue.sessionState === "failed" || issue.factoryState === "failed" || issue.factoryState === "escalated") {
    return { label: "needs help", color: "red" };
  }
  const state = issue.sessionState ?? "unknown";
  return SESSION_DISPLAY[state] ?? { label: state, color: "white" };
}

function stageDisplay(issue: WatchIssue): string {
  return STAGE_DISPLAY[effectiveState(issue)] ?? issue.factoryState;
}

function effectiveState(issue: WatchIssue): string {
  if (issue.sessionState === "done") return "done";
  if (issue.sessionState === "failed") return "failed";
  if (issue.completionCheckActive) return "completion_check";
  if (issue.blockedByCount > 0 && !issue.activeRunType) return "blocked";
  if (issue.sessionState === "waiting_input") return "awaiting_input";
  if (issue.prNumber !== undefined) return issue.factoryState;
  if (issue.readyForExecution && !issue.activeRunType && !hasDisplayPrBlocker(issue)) return "ready";
  return issue.factoryState;
}

function blockerText(issue: WatchIssue, issueContext: WatchIssueContext | null): string | null {
  const rereviewNeeded = isRereviewNeeded(issue);
  if (issue.sessionState === "waiting_input") return issue.waitingReason ?? "Waiting for input";
  if (issue.completionCheckActive) return "No PR found; checking next step";
  if (issue.sessionState === "failed" || issue.factoryState === "failed" || issue.factoryState === "escalated") {
    return issue.statusNote ?? issue.waitingReason ?? "Needs operator intervention";
  }
  if (issue.waitingReason && issue.activeRunType && issue.factoryState === "pr_open") return issue.waitingReason;
  if (issue.waitingReason && issue.activeRunType && issue.factoryState === "awaiting_queue") return issue.waitingReason;
  if (issue.waitingReason && !issue.activeRunType) return issue.waitingReason;
  if (issue.blockedByCount > 0) return `Waiting on ${issue.blockedByKeys.join(", ")}`;
  if (effectiveState(issue) === "repairing_queue") return "Merge queue conflict, repairing branch";
  if (effectiveState(issue) === "repairing_ci") {
    const check = issueContext?.latestFailureCheckName ?? issue.latestFailureCheckName ?? "CI";
    return `Repairing ${check}`;
  }
  const checks = prChecksFact({
    ...issue,
    latestFailureCheckName: issueContext?.latestFailureCheckName ?? issue.latestFailureCheckName,
  });
  if (checks?.color === "red") {
    return checks.text;
  }
  if (checks?.color === "yellow" && checks.text.startsWith("checks ")) {
    return `${checks.text} still running`;
  }
  if (rereviewNeeded) return "Awaiting re-review after requested changes";
  if (isChangesRequestedReviewState(issue.prReviewState)) return "Review changes requested";
  if (issue.prNumber !== undefined && (isAwaitingReviewState(issue.prReviewState) || (!issue.prReviewState && effectiveState(issue) !== "done"))) {
    return "Awaiting review";
  }
  return null;
}

function cleanCommand(raw: string): string {
  const bashMatch = raw.match(/^\/bin\/(?:ba)?sh\s+-\w*c\s+['"](.+?)['"]$/s);
  if (bashMatch?.[1]) return bashMatch[1];
  const bashMatch2 = raw.match(/^\/bin\/(?:ba)?sh\s+-\w*c\s+"(.+?)"$/s);
  if (bashMatch2?.[1]) return bashMatch2[1];
  return raw;
}

function lastNonEmptyLine(output: string): string {
  return output.split("\n").filter((line) => line.trim().length > 0).at(-1) ?? "";
}

function historyRunSummary(runs: HistoryRunInfo[]): string {
  const completed = runs.filter((run) => run.status === "completed").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const running = runs.filter((run) => run.status === "running").length;
  const parts = [
    completed > 0 ? `${completed} completed` : null,
    failed > 0 ? `${failed} failed` : null,
    running > 0 ? `${running} active` : null,
  ].filter((value): value is string => Boolean(value));
  return `${runs.length} runs: ${parts.join(", ")}`;
}

function feedGlyph(status?: string): string {
  if (status === "failed") return "✗";
  if (status === "completed" || status === "pr_merged") return "✓";
  return "●";
}

function blankLine(key: string): TextLine {
  return { key, segments: [] };
}

function trimTrailingBlankLines(lines: TextLine[]): TextLine[] {
  const result = [...lines];
  while (result.length > 0 && result[result.length - 1]?.segments.length === 0) {
    result.pop();
  }
  return result;
}

function segmentsToText(segments: TextSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}
