import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { AppConfig, LinearClientProvider } from "./types.ts";
import { resolvePreferredCompletedLinearState } from "./linear-workflow.ts";
import {
  buildMainRepairBranchName,
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
  /** Per-project throttle for the information-only "main is red" log. */
  private readonly lastUnhealthyReportAt = new Map<string, number>();

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly config: AppConfig,
    private readonly linearProvider: LinearClientProvider,
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
        await this.resolveRecoveredMainRepair(existing);
      }
      return;
    }

    // main CI is red. The merge queue (merge-steward) gates only on its own
    // speculative-SHA checks and ignores main entirely, so a red main no longer
    // warrants an automated repair job — main CI is information-only. Report it
    // (throttled) and post nothing. Any pre-existing repair issue is left to close
    // via resolveRecoveredMainRepair once main recovers.
    this.reportUnhealthyMain(projectId, project.github.repoFullName, baseBranch, summary);
  }

  private reportUnhealthyMain(
    projectId: string,
    repoFullName: string,
    baseBranch: string,
    summary: MainRepairCheckSummary,
  ): void {
    const now = Date.now();
    const lastReportedAt = this.lastUnhealthyReportAt.get(projectId);
    if (lastReportedAt !== undefined && now - lastReportedAt < MAIN_BRANCH_HEALTH_GRACE_MS) {
      return;
    }
    this.lastUnhealthyReportAt.set(projectId, now);
    this.logger.warn(
      {
        projectId,
        repoFullName,
        baseBranch,
        baseSha: summary.baseSha,
        failingChecks: summary.failingChecks.map((check) => check.name),
      },
      "main branch CI is red — information only; no repair job posted (merge queue gates on its own spec CI)",
    );
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

  private async resolveRecoveredMainRepair(issue: IssueRecord): Promise<void> {
    if (issue.activeRunId !== undefined) return;
    if (issue.prState === "open" || issue.factoryState === "awaiting_queue" || issue.factoryState === "pr_open") {
      return;
    }

    const linear = await this.linearProvider.forProject(issue.projectId).catch(() => undefined);
    if (linear) {
      const liveIssue = await linear.getIssue(issue.linearIssueId).catch(() => undefined);
      if (liveIssue) {
        const targetState = resolvePreferredCompletedLinearState(liveIssue);
        const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
        if (targetState && normalizedCurrent !== targetState.trim().toLowerCase()) {
          const updated = await linear.setIssueState(issue.linearIssueId, targetState).catch(() => undefined);
          if (updated) {
            this.db.upsertIssue({
              projectId: issue.projectId,
              linearIssueId: issue.linearIssueId,
              ...(updated.stateName ? { currentLinearState: updated.stateName } : {}),
              ...(updated.stateType ? { currentLinearStateType: updated.stateType } : {}),
            });
          }
        } else {
          this.db.upsertIssue({
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
            ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
          });
        }
      }
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
