import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { AppConfig } from "./types.ts";
import type { ProjectConfig } from "./workflow-types.ts";
import { execCommand } from "./utils.ts";

/**
 * Merge queue steward — keeps PatchRelay-managed PR branches up to date
 * with the base branch and enables auto-merge so GitHub merges when CI passes.
 *
 * Serialization: all calls are routed through the issue queue, and
 * prepareForMerge checks front-of-queue before acting. The issue processor
 * in service.ts checks pendingRunType before pendingMergePrep, so repair
 * runs always take priority over merge prep.
 */
export class MergeQueue {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  /**
   * Prepare the front-of-queue issue for merge:
   * 1. Enable auto-merge
   * 2. Update the branch to latest base (git merge)
   * 3. Push (triggers CI; auto-merge fires when CI passes)
   *
   * On conflict: abort merge, transition to repairing_queue, enqueue queue_repair.
   * On transient failure: leave pendingMergePrep set so the next event retries.
   */
  async prepareForMerge(issue: IssueRecord, project: ProjectConfig): Promise<void> {
    // Only prepare the front-of-queue issue for this project
    const queue = this.db.listIssuesByState(project.id, "awaiting_queue");
    const front = queue.find((i) => i.activeRunId === undefined && i.pendingRunType === undefined);
    if (!front || front.id !== issue.id) {
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, pendingMergePrep: false });
      return;
    }

    if (!issue.worktreePath || !issue.prNumber) {
      this.logger.warn({ issueKey: issue.issueKey }, "Merge prep skipped: missing worktree or PR number");
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, pendingMergePrep: false });
      return;
    }

    const repoFullName = project.github?.repoFullName;
    const baseBranch = project.github?.baseBranch ?? "main";
    const gitBin = this.config.runner.gitBin;

    // Enable auto-merge (idempotent)
    const autoMergeOk = repoFullName ? await this.enableAutoMerge(issue, repoFullName) : false;

    // Fetch latest base branch
    const fetchResult = await execCommand(gitBin, ["-C", issue.worktreePath, "fetch", "origin", baseBranch], {
      timeoutMs: 60_000,
    });
    if (fetchResult.exitCode !== 0) {
      // Transient failure — leave pendingMergePrep set so the next event retries.
      this.logger.warn({ issueKey: issue.issueKey, stderr: fetchResult.stderr?.slice(0, 300) }, "Merge prep: fetch failed, will retry on next event");
      return;
    }

    // Merge base branch into the PR branch
    const mergeResult = await execCommand(gitBin, ["-C", issue.worktreePath, "merge", `origin/${baseBranch}`, "--no-edit"], {
      timeoutMs: 60_000,
    });

    if (mergeResult.exitCode !== 0) {
      // Conflict — abort and trigger queue_repair
      await execCommand(gitBin, ["-C", issue.worktreePath, "merge", "--abort"], { timeoutMs: 10_000 });

      this.logger.info({ issueKey: issue.issueKey }, "Merge prep: conflict detected, triggering queue repair");
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        factoryState: "repairing_queue",
        pendingRunType: "queue_repair",
        pendingRunContextJson: JSON.stringify({ failureReason: "merge_conflict" }),
        pendingMergePrep: false,
      });
      this.enqueueIssue(issue.projectId, issue.linearIssueId);

      this.feed?.publish({
        level: "warn",
        kind: "workflow",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: "repairing_queue",
        status: "conflict",
        summary: `Merge conflict with ${baseBranch} — queue repair enqueued`,
      });
      return;
    }

    // Check if merge was a no-op (already up to date)
    if (mergeResult.stdout?.includes("Already up to date")) {
      this.logger.debug({ issueKey: issue.issueKey }, "Merge prep: branch already up to date");
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, pendingMergePrep: false });

      if (!autoMergeOk) {
        this.feed?.publish({
          level: "warn",
          kind: "workflow",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: "awaiting_queue",
          status: "blocked",
          summary: "Branch up to date but auto-merge not enabled — set GITHUB_TOKEN to unblock",
        });
      }
      return;
    }

    // Push the merged branch
    const pushResult = await execCommand(gitBin, ["-C", issue.worktreePath, "push"], {
      timeoutMs: 60_000,
    });

    if (pushResult.exitCode !== 0) {
      // Push failed — leave pendingMergePrep set so the next event retries.
      this.logger.warn({ issueKey: issue.issueKey, stderr: pushResult.stderr?.slice(0, 300) }, "Merge prep: push failed, will retry on next event");
      return;
    }

    this.logger.info({ issueKey: issue.issueKey, baseBranch }, "Merge prep: branch updated and pushed");
    this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, pendingMergePrep: false });

    this.feed?.publish({
      level: "info",
      kind: "workflow",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "awaiting_queue",
      status: "prepared",
      summary: `Branch updated to latest ${baseBranch} — CI will run`,
    });
  }

  /**
   * Advance the queue: find the next awaiting_queue issue and prepare it.
   * Called when a PR merges (pr_merged event).
   */
  advanceQueue(projectId: string): void {
    const queue = this.db.listIssuesByState(projectId, "awaiting_queue");
    const next = queue.find((i) => i.activeRunId === undefined && i.pendingRunType === undefined && !i.pendingMergePrep);

    if (!next) return;

    this.logger.info({ issueKey: next.issueKey, projectId }, "Advancing merge queue");
    this.db.upsertIssue({ projectId: next.projectId, linearIssueId: next.linearIssueId, pendingMergePrep: true });
    this.enqueueIssue(next.projectId, next.linearIssueId);
  }

  /** Returns true if auto-merge was successfully enabled (or already enabled). */
  private async enableAutoMerge(issue: IssueRecord, repoFullName: string): Promise<boolean> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      this.logger.warn({ issueKey: issue.issueKey }, "Merge prep: GITHUB_TOKEN not set — auto-merge cannot be enabled");
      return false;
    }

    const result = await execCommand("gh", ["pr", "merge", String(issue.prNumber), "--repo", repoFullName, "--auto", "--squash"], {
      timeoutMs: 30_000,
      env: { ...process.env, GH_TOKEN: token },
    });

    if (result.exitCode !== 0) {
      this.logger.warn(
        { issueKey: issue.issueKey, stderr: result.stderr?.slice(0, 200) },
        "Merge prep: auto-merge enablement failed",
      );
      return false;
    }
    return true;
  }
}
