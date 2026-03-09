import type { EventsResult, InspectResult, ListResultItem, OpenResult, ReportResult, RetryResult, WorktreeResult } from "../data.js";

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
    value("Lifecycle", result.issue?.lifecycleStatus),
    value("Active stage", result.activeStageRun?.stage),
    value("Latest stage", result.latestStageRun?.stage),
    value("Latest result", result.latestStageRun?.status),
    value("Workspace", result.workspace?.worktreePath),
    value("Branch", result.workspace?.branchName),
    value("Latest thread", result.activeStageRun?.threadId ?? result.issue?.latestThreadId ?? result.workspace?.lastThreadId),
    value("Latest turn", result.live?.latestTurnId ?? result.activeStageRun?.turnId ?? result.latestStageRun?.turnId),
    result.statusNote ? value("Status", truncateLine(result.statusNote)) : undefined,
    result.live?.latestTurnStatus ? value("Live turn", result.live.latestTurnStatus) : undefined,
    result.live?.latestAssistantMessage ? `Latest assistant message:\n${truncateLine(result.live.latestAssistantMessage)}` : undefined,
  ].filter(Boolean);

  return `${lines.join("\n")}\n`;
}

export function formatLive(result: Awaited<ReturnType<import("../data.js").CliDataAccess["live"]>> extends infer T ? Exclude<T, undefined> : never): string {
  const lines = [
    value("Issue", result.issue.issueKey ?? result.issue.linearIssueId),
    value("Stage", result.stageRun.stage),
    value("Thread", result.stageRun.threadId),
    value("Turn", result.live?.latestTurnId ?? result.stageRun.turnId),
    value("Turn status", result.live?.latestTurnStatus ?? result.live?.threadStatus ?? result.stageRun.status),
    value("Latest timestamp", result.live?.latestTimestampSeen),
    result.live?.latestAssistantMessage ? `Latest assistant message:\n${truncateLine(result.live.latestAssistantMessage)}` : undefined,
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

export function formatReport(result: ReportResult): string {
  const sections = result.stages.map(({ stageRun, report, summary }) => {
    const changedFiles = report?.fileChanges
      .map((entry) => (typeof entry.path === "string" ? entry.path : undefined))
      .filter(Boolean)
      .join(", ");
    const commands = report?.commands.map((command) => command.command).join(" | ");
    const tools = report?.toolCalls.map((tool) => `${tool.type}:${tool.name}`).join(", ");

    return [
      `${stageRun.stage} #${stageRun.id} ${stageRun.status}`,
      value("Started", stageRun.startedAt),
      value("Ended", stageRun.endedAt),
      value("Thread", stageRun.threadId),
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

  return `${value("Stage run", result.stageRun.id)}\n${value("Stage", result.stageRun.stage)}\n\n${sections.join("\n\n")}\n`;
}

export function formatWorktree(result: WorktreeResult, cdOnly: boolean): string {
  if (cdOnly) {
    return `${result.workspace.worktreePath}\n`;
  }

  return `${[
    value("Issue", result.issue.issueKey ?? result.issue.linearIssueId),
    value("Worktree", result.workspace.worktreePath),
    value("Branch", result.workspace.branchName),
    value("Repo", result.repoId),
  ].join("\n")}\n`;
}

export function formatOpen(result: OpenResult): string {
  const commands = [
    `cd ${result.workspace.worktreePath}`,
    "git branch --show-current",
    "codex --dangerously-bypass-approvals-and-sandbox",
  ];
  if (result.resumeThreadId) {
    commands.push(`codex --dangerously-bypass-approvals-and-sandbox resume ${result.resumeThreadId}`);
  }
  return `${commands.join("\n")}\n`;
}

export function formatRetry(result: RetryResult): string {
  return `${[
    value("Issue", result.issue.issueKey ?? result.issue.linearIssueId),
    value("Queued stage", result.stage),
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
        item.lifecycleStatus,
        item.activeStage ?? "-",
        item.latestStage ? `${item.latestStage}:${item.latestStageStatus ?? "-"}` : "-",
        item.updatedAt,
      ].join("\t"),
    )
    .join("\n")}\n`;
}
