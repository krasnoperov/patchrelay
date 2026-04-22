import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { AppConfig, LinearClientProvider } from "./types.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import {
  buildMainRepairBranchName,
  buildMainRepairDescription,
  buildMainRepairPromptContext,
  buildMainRepairTitle,
  isMainRepairIssue,
  type MainRepairCheckSummary,
} from "./main-repair.ts";
import { execCommand } from "./utils.ts";

const MAIN_BRANCH_HEALTH_GRACE_MS = 120_000;

interface MainBranchCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  details_url?: string;
}

function isUnhealthyMainConclusion(conclusion: string | null | undefined): boolean {
  return conclusion === "failure"
    || conclusion === "timed_out"
    || conclusion === "cancelled"
    || conclusion === "action_required"
    || conclusion === "stale";
}

export class MainBranchHealthMonitor {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly config: AppConfig,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async reconcile(): Promise<void> {
    for (const project of this.config.projects) {
      await this.reconcileProject(project.id);
    }
  }

  private async reconcileProject(projectId: string): Promise<void> {
    const project = this.config.projects.find((entry) => entry.id === projectId);
    if (!project?.github?.repoFullName) return;
    if (project.linearTeamIds.length === 0) return;

    const baseBranch = project.github.baseBranch ?? "main";
    const branchName = buildMainRepairBranchName(baseBranch);
    const existing = this.findExistingMainRepair(projectId, branchName);

    const summary = await this.readMainBranchFailure(project.github.repoFullName, baseBranch);
    if (!summary) {
      if (existing) {
        this.resolveRecoveredMainRepair(existing);
      }
      return;
    }

    const protocol = resolveMergeQueueProtocol(project);
    if (existing) {
      const age = Date.now() - Date.parse(existing.updatedAt);
      if (age < MAIN_BRANCH_HEALTH_GRACE_MS) {
        return;
      }
    }
    if (existing) {
      this.queueExistingMainRepair(existing, summary, protocol.priorityLabel);
      return;
    }

    const client = await this.linearProvider.forProject(projectId);
    if (!client?.createIssue) {
      this.logger.warn({ projectId, repoFullName: project.github.repoFullName }, "Cannot create main repair issue because Linear issue creation is unavailable");
      return;
    }

    const created = await client.createIssue({
      teamId: project.linearTeamIds[0]!,
      title: buildMainRepairTitle(project),
      description: buildMainRepairDescription(project, summary, protocol.priorityLabel),
    });

    const issue = this.db.upsertIssue({
      projectId,
      linearIssueId: created.id,
      delegatedToPatchRelay: true,
      ...(created.identifier ? { issueKey: created.identifier } : {}),
      ...(created.title ? { title: created.title } : {}),
      ...(created.description ? { description: created.description } : {}),
      ...(created.url ? { url: created.url } : {}),
      ...(created.priority != null ? { priority: created.priority } : {}),
      ...(created.estimate != null ? { estimate: created.estimate } : {}),
      ...(created.stateName ? { currentLinearState: created.stateName } : {}),
      ...(created.stateType ? { currentLinearStateType: created.stateType } : {}),
      branchName,
      factoryState: "delegated",
    });

    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(projectId, issue.linearIssueId, {
      projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "delegated",
      eventJson: JSON.stringify({
        runType: "main_repair",
        baseSha: summary.baseSha,
        failingChecks: summary.failingChecks,
        pendingChecks: summary.pendingChecks,
        priorityLabel: protocol.priorityLabel,
        promptContext: buildMainRepairPromptContext(project, summary, protocol.priorityLabel),
      }),
      dedupeKey: `main_repair:${projectId}:${summary.baseSha}:${summary.failingChecks.map((check) => check.name).join("|")}`,
    });

    if (this.db.issueSessions.peekIssueSessionWake(projectId, issue.linearIssueId)) {
      this.enqueueIssue(projectId, issue.linearIssueId);
    }

    this.feed?.publish({
      level: "warn",
      kind: "github",
      issueKey: issue.issueKey,
      projectId,
      stage: "delegated",
      status: "main_repair_queued",
      summary: `Queued main_repair for ${project.github.repoFullName}@${baseBranch}`,
      detail: summary.failingChecks.map((check) => check.name).join(", "),
    });
  }

  private findExistingMainRepair(projectId: string, branchName: string): IssueRecord | undefined {
    const candidates = this.db.listIssues()
      .filter((issue) => (
        issue.projectId === projectId
        && issue.branchName === branchName
        && isMainRepairIssue(issue)
        && issue.factoryState !== "done"
      ))
      .sort((left, right) => this.compareMainRepairCandidates(left, right));
    return candidates[0];
  }

  private compareMainRepairCandidates(left: IssueRecord, right: IssueRecord): number {
    const leftPriority = this.rankMainRepairCandidate(left);
    const rightPriority = this.rankMainRepairCandidate(right);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  }

  private rankMainRepairCandidate(issue: IssueRecord): number {
    if (issue.activeRunId !== undefined) return 0;
    if (issue.prState === "open" || issue.factoryState === "awaiting_queue" || issue.factoryState === "pr_open") return 1;
    if (issue.factoryState === "delegated" || issue.factoryState === "implementing") return 2;
    if (issue.factoryState === "failed" || issue.factoryState === "escalated") return 3;
    return 4;
  }

  private queueExistingMainRepair(issue: IssueRecord, summary: MainRepairCheckSummary, priorityLabel: string): void {
    if (issue.activeRunId !== undefined) return;
    if (this.db.issueSessions.hasPendingIssueSessionEvents(issue.projectId, issue.linearIssueId)) return;
    if (issue.prState === "open" || issue.factoryState === "awaiting_queue" || issue.factoryState === "pr_open") return;

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      delegatedToPatchRelay: true,
      factoryState: "delegated",
      pendingRunType: null,
      pendingRunContextJson: null,
      activeRunId: null,
    });

    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "delegated",
      eventJson: JSON.stringify({
        runType: "main_repair",
        baseSha: summary.baseSha,
        failingChecks: summary.failingChecks,
        pendingChecks: summary.pendingChecks,
        priorityLabel,
        promptContext: buildMainRepairPromptContext(
          this.config.projects.find((project) => project.id === issue.projectId) ?? { id: issue.projectId },
          summary,
          priorityLabel,
        ),
      }),
      dedupeKey: `main_repair:${issue.projectId}:${summary.baseSha}:${summary.failingChecks.map((check) => check.name).join("|")}`,
    });
    if (this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
      this.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
  }

  private resolveRecoveredMainRepair(issue: IssueRecord): void {
    if (issue.activeRunId !== undefined) return;
    if (issue.prState === "open" || issue.factoryState === "awaiting_queue" || issue.factoryState === "pr_open") {
      return;
    }

    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      factoryState: "done",
      pendingRunType: null,
    });

    this.feed?.publish({
      level: "info",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "done",
      status: "main_repair_resolved",
      summary: "Closed stale main_repair after main recovered externally",
    });
  }

  private async readMainBranchFailure(repoFullName: string, baseBranch: string): Promise<MainRepairCheckSummary | undefined> {
    const { stdout: shaOut } = await execCommand("gh", [
      "api",
      `repos/${repoFullName}/branches/${baseBranch}`,
      "--jq",
      ".commit.sha",
    ], { timeoutMs: 10_000 });
    const baseSha = shaOut.trim();
    if (!baseSha) return undefined;

    const { stdout: checksOut } = await execCommand("gh", [
      "api",
      `repos/${repoFullName}/commits/${baseSha}/check-runs`,
      "--jq",
      ".check_runs",
    ], { timeoutMs: 10_000 });

    const runs = JSON.parse(checksOut || "[]") as MainBranchCheckRun[];
    const failingChecks = runs
      .filter((run) => run.status === "completed" && isUnhealthyMainConclusion(run.conclusion) && typeof run.name === "string" && run.name.trim())
      .map((run) => ({ name: run.name!.trim(), ...(run.details_url ? { url: run.details_url } : {}) }));
    if (failingChecks.length === 0) {
      return undefined;
    }

    const pendingChecks = runs
      .filter((run) => run.status !== "completed" && typeof run.name === "string" && run.name.trim())
      .map((run) => ({ name: run.name!.trim(), ...(run.details_url ? { url: run.details_url } : {}) }));

    return {
      baseSha,
      failingChecks,
      pendingChecks,
    };
  }
}
