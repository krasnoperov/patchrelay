import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import type { AppConfig, LinearClientProvider, LinearAgentActivityContent } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { buildAgentSessionPlanForIssue } from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import { derivePatchRelayWaitingReason } from "./waiting-reason.ts";

const PROGRESS_THROTTLE_MS = 5_000;

export class LinearSessionSync {
  private readonly progressThrottle = new Map<number, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  private ensureAgentSessionIssue(issue: IssueRecord): IssueRecord {
    if (issue.agentSessionId) {
      return issue;
    }

    const recoveredAgentSessionId = this.db.findLatestAgentSessionIdForIssue(issue.linearIssueId);
    if (!recoveredAgentSessionId) return issue;

    this.logger.info({ issueKey: issue.issueKey, agentSessionId: recoveredAgentSessionId }, "Recovered missing Linear agent session id from webhook history");
    return this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      agentSessionId: recoveredAgentSessionId,
    });
  }

  async emitActivity(
    issue: IssueRecord,
    content: LinearAgentActivityContent,
    options?: { ephemeral?: boolean },
  ): Promise<void> {
    const syncedIssue = this.ensureAgentSessionIssue(issue);
    if (!syncedIssue.agentSessionId) return;
    try {
      const linear = await this.linearProvider.forProject(syncedIssue.projectId);
      if (!linear) return;
      const allowEphemeral = content.type === "thought" || content.type === "action";
      await linear.createAgentActivity({
        agentSessionId: syncedIssue.agentSessionId,
        content,
        ...(options?.ephemeral && allowEphemeral ? { ephemeral: true } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: syncedIssue.issueKey, type: content.type, error: msg }, "Failed to emit Linear activity");
      this.feed?.publish({
        level: "warn",
        kind: "linear",
        issueKey: syncedIssue.issueKey,
        projectId: syncedIssue.projectId,
        status: "linear_error",
        summary: `Linear activity failed: ${msg}`,
      });
    }
  }

  async syncSession(issue: IssueRecord, options?: { activeRunType?: RunType }): Promise<void> {
    const syncedIssue = this.ensureAgentSessionIssue(issue);
    try {
      const linear = await this.linearProvider.forProject(syncedIssue.projectId);
      if (!linear) return;
      if (syncedIssue.agentSessionId && linear.updateAgentSession) {
        const externalUrls = buildAgentSessionExternalUrls(this.config, {
          ...(syncedIssue.issueKey ? { issueKey: syncedIssue.issueKey } : {}),
          ...(syncedIssue.prUrl ? { prUrl: syncedIssue.prUrl } : {}),
        });
        await linear.updateAgentSession({
          agentSessionId: syncedIssue.agentSessionId,
          plan: buildAgentSessionPlanForIssue(syncedIssue, options),
          ...(externalUrls ? { externalUrls } : {}),
        });
      }
      await this.syncStatusComment(syncedIssue, linear, options);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: syncedIssue.issueKey, error: msg }, "Failed to update Linear plan");
    }
  }

  async syncCodexPlan(issue: IssueRecord, params: Record<string, unknown>): Promise<void> {
    const syncedIssue = this.ensureAgentSessionIssue(issue);
    if (!syncedIssue.agentSessionId) return;
    const plan = params.plan;
    if (!Array.isArray(plan)) return;

    const STATUS_MAP: Record<string, "pending" | "inProgress" | "completed"> = {
      pending: "pending",
      inProgress: "inProgress",
      completed: "completed",
    };

    const steps = plan.map((entry) => {
      const e = entry as Record<string, unknown>;
      const step = typeof e.step === "string" ? e.step : String(e.step ?? "");
      const status = typeof e.status === "string" ? (STATUS_MAP[e.status] ?? "pending") : "pending";
      return { content: step, status };
    });

    const fullPlan = [
      { content: "Prepare workspace", status: "completed" as const },
      ...steps,
      { content: "Merge", status: "pending" as const },
    ];

    try {
      const linear = await this.linearProvider.forProject(syncedIssue.projectId);
      if (!linear?.updateAgentSession) return;
      await linear.updateAgentSession({
        agentSessionId: syncedIssue.agentSessionId,
        plan: fullPlan,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: syncedIssue.issueKey, error: msg }, "Failed to sync codex plan to Linear");
    }
  }

  maybeEmitProgress(notification: { method: string; params: Record<string, unknown> }, run: RunRecord): void {
    const activity = resolveProgressActivity(notification);
    if (!activity) return;

    const now = Date.now();
    const lastEmit = this.progressThrottle.get(run.id) ?? 0;
    if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
    this.progressThrottle.set(run.id, now);

    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (issue) {
      void this.emitActivity(issue, activity, { ephemeral: true });
    }
  }

  clearProgress(runId: number): void {
    this.progressThrottle.delete(runId);
  }

  private async syncStatusComment(
    issue: IssueRecord,
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
    options?: { activeRunType?: RunType },
  ): Promise<void> {
    try {
      const body = renderStatusComment(this.db, issue, options);
      const result = await linear.upsertIssueComment({
        issueId: issue.linearIssueId,
        ...(issue.statusCommentId ? { commentId: issue.statusCommentId } : {}),
        body,
      });
      if (result.id !== issue.statusCommentId) {
        this.db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          statusCommentId: result.id,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to sync Linear status comment");
    }
  }
}

function resolveProgressActivity(notification: { method: string; params: Record<string, unknown> }): LinearAgentActivityContent | undefined {
  if (notification.method === "item/started") {
    const item = notification.params.item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    const type = typeof item.type === "string" ? item.type : undefined;

    if (type === "commandExecution") {
      const cmd = item.command;
      const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : undefined;
      return { type: "action", action: "Running", parameter: cmdStr?.slice(0, 120) ?? "command" };
    }
    if (type === "mcpToolCall") {
      const server = typeof item.server === "string" ? item.server : "";
      const tool = typeof item.tool === "string" ? item.tool : "";
      return { type: "action", action: "Using", parameter: `${server}/${tool}` };
    }
    if (type === "dynamicToolCall") {
      const tool = typeof item.tool === "string" ? item.tool : "tool";
      return { type: "action", action: "Using", parameter: tool };
    }
  }
  return undefined;
}

function renderStatusComment(
  db: PatchRelayDatabase,
  issue: IssueRecord,
  options?: { activeRunType?: RunType },
): string {
  const activeRun = issue.activeRunId ? db.getRun(issue.activeRunId) : undefined;
  const latestRun = db.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
  const activeRunType = issue.activeRunId !== undefined
    ? (options?.activeRunType ?? activeRun?.runType)
    : undefined;
  const waitingReason = derivePatchRelayWaitingReason({
    ...(activeRunType ? { activeRunType } : {}),
    ...(issue.activeRunId !== undefined ? { activeRunId: issue.activeRunId } : {}),
    factoryState: issue.factoryState,
    pendingRunType: issue.pendingRunType,
    ...(issue.prNumber !== undefined ? { prNumber: issue.prNumber } : {}),
    prReviewState: issue.prReviewState,
    prCheckStatus: issue.prCheckStatus,
    queueLabelApplied: issue.queueLabelApplied,
    latestFailureCheckName: issue.lastGitHubFailureCheckName,
  });

  const lines = [
    "## PatchRelay status",
    "",
    statusHeadline(issue, activeRunType),
  ];

  if (waitingReason) {
    lines.push("", `Waiting: ${waitingReason}`);
  }

  if (issue.prNumber !== undefined || issue.prUrl) {
    const prLabel = issue.prNumber !== undefined ? `#${issue.prNumber}` : "open";
    lines.push("", `PR: ${issue.prUrl ? `[${prLabel}](${issue.prUrl})` : prLabel}`);
  }

  if (latestRun) {
    lines.push("", `Latest run: ${formatLatestRun(latestRun)}`);
    if (latestRun.failureReason) {
      lines.push("", `Failure: ${latestRun.failureReason}`);
    }
  }

  if (issue.lastGitHubFailureCheckName && (issue.factoryState === "repairing_ci" || issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure")) {
    lines.push("", `Latest failing check: ${issue.lastGitHubFailureCheckName}`);
  }

  lines.push(
    "",
    "_PatchRelay updates this comment as it works. Review and merge remain downstream._",
  );

  return lines.join("\n");
}

function statusHeadline(issue: IssueRecord, activeRunType?: string): string {
  if (activeRunType) {
    return `Running ${humanize(activeRunType)}`;
  }
  switch (issue.factoryState) {
    case "delegated":
      return "Queued to start work";
    case "implementing":
      return "Implementing requested change";
    case "pr_open":
      return issue.prNumber !== undefined ? `PR #${issue.prNumber} opened` : "PR opened";
    case "changes_requested":
      return "Addressing requested review changes";
    case "repairing_ci":
      return "Repairing failing CI";
    case "awaiting_queue":
      return "Handed off downstream for merge";
    case "repairing_queue":
      return "Repairing merge handoff";
    case "awaiting_input":
      return "Waiting for more input";
    case "failed":
      return "Needs operator intervention";
    case "escalated":
      return "Escalated for human help";
    case "done":
      return issue.prNumber !== undefined ? `Completed with PR #${issue.prNumber}` : "Completed";
    default:
      return humanize(issue.factoryState);
  }
}

function formatLatestRun(run: Pick<RunRecord, "runType" | "status" | "endedAt" | "startedAt">): string {
  const at = run.endedAt ?? run.startedAt;
  return `${humanize(run.runType)} ${run.status} at ${at}`;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}
