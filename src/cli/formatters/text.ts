import type {
  CloseResult,
  IssueTraceResult,
  OpenResult,
  PromptResult,
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

function formatRecord(record: Record<string, unknown> | undefined): string | undefined {
  if (!record || Object.keys(record).length === 0) return undefined;
  return truncateLine(JSON.stringify(record));
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

export function formatPrompt(result: PromptResult): string {
  return `${[
    value("Issue", result.issueKey),
    value("Delivered", result.delivered ? "yes" : "no"),
    result.queued ? value("Queued", "yes") : undefined,
  ]
    .filter(Boolean)
    .join("\n")}\n`;
}

export function formatTrace(result: IssueTraceResult): string {
  const lines = [
    `${result.issue.issueKey ?? result.issue.linearIssueId}${result.issue.currentLinearState ? `  ${result.issue.currentLinearState}` : ""}`,
    value("Workflow status", result.snapshot.status),
    value("Execution state", formatRecord(result.executionState)),
    result.activeRun ? value("Active run", `#${result.activeRun.id} ${result.activeRun.runType} ${result.activeRun.status}`) : value("Active run", "none"),
    value("Authority", `${result.snapshot.authority.delegated ? "delegated" : "revoked"} epoch=${result.snapshot.authority.epoch}`),
    value("Blockers", result.snapshot.blockerCount),
    value("Children", `${result.snapshot.openChildCount}/${result.snapshot.childCount} open`),
  ];

  if (result.snapshot.artifacts.length > 0) {
    lines.push("");
    lines.push("Artifacts");
    for (const artifact of result.snapshot.artifacts) {
      lines.push([
        `- ${artifact.type}`,
        artifact.ref,
        artifact.state ? `state=${artifact.state}` : undefined,
        formatRecord(artifact.metadata),
      ].filter(Boolean).join("  "));
    }
  }

  lines.push("");
  lines.push("Workflow tasks");
  if (result.tasks.length === 0) {
    lines.push("- none");
  } else {
    for (const task of result.tasks) {
      lines.push([
        `- ${task.status}`,
        task.taskId,
        task.taskType,
        task.runType ? `run=${task.runType}` : undefined,
        `gate=${task.gateAction}`,
        `epoch=${task.authorityEpoch}`,
        task.gateReason ? `reason=${truncateLine(task.gateReason)}` : undefined,
      ].filter(Boolean).join("  "));
    }
  }

  lines.push("");
  lines.push("Observations");
  if (result.observations.length === 0) {
    lines.push("- none");
  } else {
    for (const observation of result.observations.slice(-20)) {
      lines.push([
        `- #${observation.id}`,
        observation.observedAt,
        `${observation.source}:${observation.type}`,
        observation.dedupeKey ? `dedupe=${observation.dedupeKey}` : undefined,
        formatRecord(observation.payload),
      ].filter(Boolean).join("  "));
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatClose(result: CloseResult): string {
  return `${[
    value("Issue", result.issue.issueKey ?? result.issue.linearIssueId),
    value("Closed as", result.phase),
    result.releasedRunId ? value("Released run", result.releasedRunId) : undefined,
    result.reason ? value("Reason", result.reason) : undefined,
  ]
    .filter(Boolean)
    .join("\n")}\n`;
}
