import type {
  CloseResult,
  InspectResult,
  IssueSessionHistoryResult,
  IssueTranscriptSourceResult,
  ListResultItem,
  LiveResult,
  OpenResult,
  RetryResult,
  WorktreeResult,
} from "../data.ts";

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
    value("Session", result.issue?.sessionState),
    value("Waiting reason", result.issue?.waitingReason ?? result.issue?.statusNote),
    value("Debug stage", result.issue?.factoryState),
    result.activeRun ? value("Active run", `${result.activeRun.runType} (${result.activeRun.status})`) : undefined,
    result.latestRun && !result.activeRun ? value("Latest run", `${result.latestRun.runType} (${result.latestRun.status})`) : undefined,
    result.prNumber
      ? value(
          "PR",
          `#${result.prNumber}${
            result.prState || result.prReviewState
              ? ` [${[result.prState, result.prReviewState].filter(Boolean).join(", ")}]`
              : ""
          }`,
        )
      : undefined,
    result.completionCheckOutcome ? value("Completion check", result.completionCheckOutcome) : undefined,
    result.completionCheckSummary ? value("Completion summary", truncateLine(result.completionCheckSummary)) : undefined,
    result.completionCheckQuestion ? value("Question", truncateLine(result.completionCheckQuestion)) : undefined,
    result.completionCheckWhy ? value("Why", truncateLine(result.completionCheckWhy)) : undefined,
    result.completionCheckRecommendedReply ? value("Suggested reply", truncateLine(result.completionCheckRecommendedReply)) : undefined,
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
    commands.push(`# No resumable thread found; \`patchrelay issue open ${result.issue.issueKey ?? result.issue.linearIssueId}\` will create a fresh session.`);
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

export function formatClose(result: CloseResult): string {
  return `${[
    value("Issue", result.issue.issueKey ?? result.issue.linearIssueId),
    value("Closed as", result.factoryState),
    result.releasedRunId ? value("Released run", result.releasedRunId) : undefined,
    result.reason ? value("Reason", result.reason) : undefined,
  ]
    .filter(Boolean)
    .join("\n")}\n`;
}

function formatTimestampRange(startedAt: string, endedAt?: string): string {
  return endedAt ? `${startedAt} -> ${endedAt}` : `${startedAt} -> running`;
}

function formatSessionSource(sessionSource: { exists: boolean; path?: string; error?: string } | undefined): string | undefined {
  if (!sessionSource) return undefined;
  if (sessionSource.exists) return sessionSource.path;
  return sessionSource.error ?? "not found";
}

export function formatTranscriptSource(result: IssueTranscriptSourceResult): string {
  const lines = [
    value("Issue", result.issue.issueKey ?? result.issue.linearIssueId),
    value("Worktree", result.worktreePath),
    value(
      "Run",
      result.runId !== undefined
        ? `#${result.runId}${result.runType ? ` ${result.runType}` : ""}${result.runStatus ? ` (${result.runStatus})` : ""}`
        : undefined,
    ),
    value("Thread", result.threadId),
    value("Turn", result.turnId),
    value("Session source", formatSessionSource(result.sessionSource)),
    result.sessionSource?.startedAt ? value("Started", result.sessionSource.startedAt) : undefined,
    result.sessionSource?.originator ? value("Originator", result.sessionSource.originator) : undefined,
    result.sessionSource?.cwd ? value("Working directory", result.sessionSource.cwd) : undefined,
  ].filter(Boolean);

  return `${lines.join("\n")}\n`;
}

export function formatSessionHistory(
  result: IssueSessionHistoryResult,
  buildOpenForThread?: (threadId: string) => { command: string; args: string[] },
): string {
  const lines = [
    `${result.issue.issueKey ?? result.issue.linearIssueId}${result.issue.currentLinearState ? `  ${result.issue.currentLinearState}` : ""}`,
    value("Worktree", result.worktreePath),
    value("Current thread", result.currentThreadId),
  ];

  if (result.sessions.length === 0) {
    lines.push("No recorded app-server sessions.");
    return `${lines.join("\n")}\n`;
  }

  for (const session of result.sessions) {
    lines.push("");
    lines.push(
      [
        `run #${session.runId}`,
        session.runType,
        session.status,
        formatTimestampRange(session.startedAt, session.endedAt),
        session.isCurrentThread ? "current" : undefined,
      ]
        .filter(Boolean)
        .join("  "),
    );
    lines.push(value("Thread", session.threadId));
    if (session.parentThreadId) {
      lines.push(value("Parent thread", session.parentThreadId));
    }
    if (session.turnId) {
      lines.push(value("Turn", session.turnId));
    }
    lines.push(value(
      "Events",
      session.eventCountAvailable
        ? session.eventCount
        : "not persisted (persistExtendedHistory=false)",
    ));
    if (session.summary) {
      lines.push(value("Summary", truncateLine(session.summary)));
    } else if (session.failureReason) {
      lines.push(value("Failure", truncateLine(session.failureReason)));
    }
    if (session.sessionSource) {
      lines.push(value("Session source", formatSessionSource(session.sessionSource)));
      if (session.sessionSource.startedAt) {
        lines.push(value("Started", session.sessionSource.startedAt));
      }
      if (session.sessionSource.originator) {
        lines.push(value("Originator", session.sessionSource.originator));
      }
      if (session.sessionSource.cwd) {
        lines.push(value("Working directory", session.sessionSource.cwd));
      }
    }
    if (session.threadId && result.worktreePath && buildOpenForThread) {
      const command = buildOpenForThread(session.threadId);
      lines.push(value("Open", formatCommand(command.command, command.args)));
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatList(items: ListResultItem[]): string {
  return `${items
    .map((item) =>
      [
        item.issueKey ?? "-",
        item.currentLinearState ?? "-",
        item.sessionState ?? "-",
        item.waitingReason ?? "-",
        item.activeRunType ?? "-",
        item.latestRunType ? `${item.latestRunType}:${item.latestRunStatus ?? "-"}` : "-",
        item.updatedAt,
        item.factoryState,
      ].join("\t"),
    )
    .join("\n")}\n`;
}
