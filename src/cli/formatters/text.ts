import type { EventsResult, InspectResult, ListResultItem, LiveResult, OpenResult, OperatorFeedResult, ReportResult, RetryResult, WorktreeResult } from "../data.ts";
import type { OperatorFeedEvent } from "../../operator-feed.ts";

function value(label: string, entry: string | number | undefined): string {
  return `${label}: ${entry ?? "-"}`;
}

function truncateLine(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const normalized = input.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

export function formatInspect(result: InspectResult): string {
  const header = [result.issue?.issueKey ?? result.issue?.linearIssueId ?? "unknown", result.issue?.currentLinearState]
    .filter(Boolean)
    .join("  ");
  const lines = [
    header,
    value("Title", result.issue?.title),
    value("State", result.issue?.factoryState),
    value("Active run", result.activeRun?.runType),
    value("Active run status", result.activeRun?.status),
    result.statusNote ? value("Status", truncateLine(result.statusNote)) : undefined,
  ].filter(Boolean);

  return `${lines.join("\n")}\n`;
}

export function formatLive(result: LiveResult): string {
  const lines = [
    value("Issue", result.issue.issueKey ?? result.issue.linearIssueId),
    value("Run type", result.run.runType),
    value("Thread", result.run.threadId),
    value("Turn", result.live?.latestTurnId ?? result.run.turnId),
    value("Turn status", result.live?.latestTurnStatus ?? result.live?.threadStatus ?? result.run.status),
    value("Latest timestamp", result.live?.latestTimestampSeen),
    result.live?.latestAssistantMessage ? `Latest assistant message:\n${truncateLine(result.live.latestAssistantMessage)}` : undefined,
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

export function formatReport(result: ReportResult): string {
  const sections = result.runs.map(({ run, report, summary }) => {
    const changedFiles = report?.fileChanges
      .map((entry: Record<string, unknown>) => (typeof entry.path === "string" ? entry.path : undefined))
      .filter(Boolean)
      .join(", ");
    const commands = report?.commands.map((command: { command: string }) => command.command).join(" | ");
    const tools = report?.toolCalls.map((tool: { type: string; name: string }) => `${tool.type}:${tool.name}`).join(", ");

    return [
      `${run.runType} #${run.id} ${run.status}`,
      value("Started", run.startedAt),
      value("Ended", run.endedAt),
      value("Thread", run.threadId),
      summary?.latestAssistantMessage ? value("Summary", truncateLine(String(summary.latestAssistantMessage))) : undefined,
      report?.assistantMessages.at(-1) ? value("Assistant conclusion", truncateLine(report.assistantMessages.at(-1))) : undefined,
      commands ? value("Commands", commands) : undefined,
      changedFiles ? value("Changed files", changedFiles) : undefined,
      tools ? value("Tool calls", tools) : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return `${sections.join("\n\n")}\n`;
}

export function formatEvents(result: EventsResult): string {
  const sections = result.events.map((event) =>
    [
      `#${event.id} ${event.createdAt} ${event.method}`,
      value("Thread", event.threadId),
      value("Turn", event.turnId),
      event.parsedEvent ? JSON.stringify(event.parsedEvent, null, 2) : event.eventJson,
    ].join("\n"),
  );

  return `${value("Run", result.run.id)}\n${value("Run type", result.run.runType)}\n\n${sections.join("\n\n")}\n`;
}

export function formatWorktree(result: WorktreeResult, cdOnly: boolean): string {
  if (cdOnly) {
    return `${result.worktreePath}\n`;
  }

  return `${[
    value("Issue", result.issue.issueKey ?? result.issue.linearIssueId),
    value("Worktree", result.worktreePath),
    value("Branch", result.branchName),
    value("Repo", result.repoId),
  ].join("\n")}\n`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export function formatOpen(
  result: OpenResult,
  command?: { command: string; args: string[] },
): string {
  const commands = [
    `cd ${result.worktreePath}`,
    "git branch --show-current",
  ];
  if (result.needsNewSession) {
    commands.push(`# No resumable thread found; \`patchrelay open ${result.issue.issueKey ?? result.issue.linearIssueId}\` will create a fresh session.`);
  }
  commands.push(
    command
      ? formatCommand(command.command, command.args)
      : result.resumeThreadId
        ? `codex --dangerously-bypass-approvals-and-sandbox resume ${result.resumeThreadId}`
        : "codex --dangerously-bypass-approvals-and-sandbox",
  );
  return `${commands.join("\n")}\n`;
}

export function formatRetry(result: RetryResult): string {
  return `${[
    value("Issue", result.issue.issueKey ?? result.issue.linearIssueId),
    value("Queued stage", result.runType),
    result.reason ? value("Reason", result.reason) : undefined,
  ]
    .filter(Boolean)
    .join("\n")}\n`;
}

export function formatList(items: ListResultItem[]): string {
  return `${items
    .map((item) =>
      [
        item.issueKey ?? "-",
        item.currentLinearState ?? "-",
        item.factoryState,
        item.activeRunType ?? "-",
        item.latestRunType ? `${item.latestRunType}:${item.latestRunStatus ?? "-"}` : "-",
        item.updatedAt,
      ].join("\t"),
    )
    .join("\n")}\n`;
}

function colorize(enabled: boolean, code: string, value: string): string {
  return enabled ? `\u001B[${code}m${value}\u001B[0m` : value;
}

function formatFeedStatus(event: OperatorFeedEvent, color: boolean): string {
  const raw = event.status ?? event.kind;
  const label = raw.replaceAll("_", " ");
  const padded = label.padEnd(15);
  if (event.level === "error" || raw === "failed" || raw === "delivery_failed") {
    return colorize(color, "31", padded);
  }
  if (event.level === "warn" || raw === "ignored" || raw === "fallback" || raw === "handoff" || raw === "transition_suppressed") {
    return colorize(color, "33", padded);
  }
  if (raw === "running" || raw === "started" || raw === "delegated" || raw === "transition_chosen" || raw === "completed") {
    return colorize(color, "32", padded);
  }
  if (raw === "queued" || raw === "selected") {
    return colorize(color, "36", padded);
  }
  return colorize(color, "2", padded);
}

function formatFeedMeta(event: OperatorFeedEvent, color: boolean): string | undefined {
  const parts = [
    event.workflowId ? `workflow:${event.workflowId}` : undefined,
    event.stage ? `stage:${event.stage}` : undefined,
    event.nextStage ? `next:${event.nextStage}` : undefined,
  ].filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return colorize(color, "2", `[${parts.join(" ")}]`);
}

export function formatOperatorFeedEvent(event: OperatorFeedEvent, options?: { color?: boolean }): string {
  const color = options?.color === true;
  const timestamp = new Date(event.at).toLocaleTimeString("en-GB", { hour12: false });
  const issue = event.issueKey ?? event.projectId ?? "-";
  const meta = formatFeedMeta(event, color);
  const line = [
    colorize(color, "2", timestamp),
    colorize(color, "1", issue.padEnd(10)),
    formatFeedStatus(event, color),
    event.summary,
    ...(meta ? [meta] : []),
  ].join("  ");

  if (!event.detail) {
    return `${line}\n`;
  }

  return `${line}\n${colorize(color, "2", `  ${truncateLine(event.detail)}`)}\n`;
}

export function formatOperatorFeed(result: OperatorFeedResult, options?: { color?: boolean }): string {
  if (result.events.length === 0) {
    return "No feed events yet.\n";
  }

  return result.events.map((event) => formatOperatorFeedEvent(event, options)).join("");
}
