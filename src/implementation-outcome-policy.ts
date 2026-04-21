import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import type { AppConfig } from "./types.ts";
import { execCommand } from "./utils.ts";

export class ImplementationOutcomePolicy {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly withHeldLease: WithHeldIssueSessionLease,
  ) {}

  async verifyPublishedRunOutcome(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    if (run.runType !== "implementation") {
      return undefined;
    }
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    const baseBranch = project?.github?.baseBranch ?? "main";
    const publishedPrState = await this.detectPublishedPrState(issue, project?.github?.repoFullName);
    if (publishedPrState === "open") {
      return undefined;
    }

    const details = await this.describeLocalImplementationOutcome(issue, baseBranch);
    return details ?? `Implementation completed without opening a PR for branch ${issue.branchName ?? issue.linearIssueId}`;
  }

  async detectRecoverableFailedImplementationOutcome(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    if (run.runType !== "implementation") {
      return undefined;
    }
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    const publishedPrState = await this.detectPublishedPrState(issue, project?.github?.repoFullName);
    if (publishedPrState === "open" || publishedPrState === "unknown") {
      return undefined;
    }

    const baseBranch = project?.github?.baseBranch ?? "main";
    return await this.describeLocalImplementationOutcome(issue, baseBranch);
  }

  private async detectPublishedPrState(
    issue: IssueRecord,
    repoFullName: string | undefined,
  ): Promise<"open" | "closed" | "none" | "unknown"> {
    if (issue.prNumber && issue.prState && issue.prState !== "closed") {
      return "open";
    }
    if (!repoFullName || !issue.branchName) {
      return "unknown";
    }

    try {
      const { stdout, exitCode } = await execCommand("gh", [
        "pr",
        "list",
        "--repo",
        repoFullName,
        "--head",
        issue.branchName,
        "--state",
        "all",
        "--json",
        "number,url,state,author,headRefOid",
      ], { timeoutMs: 10_000 });
      if (exitCode !== 0) {
        return "unknown";
      }

      const matches = JSON.parse(stdout) as Array<{
        number?: number;
        url?: string;
        state?: string;
        headRefOid?: string;
        author?: { login?: string };
      }>;
      const pr = matches[0];
      if (!pr?.number) {
        return "none";
      }

      const state = pr.state?.toLowerCase();
      this.upsertIssueIfLeaseHeld(
        issue.projectId,
        issue.linearIssueId,
        {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          prNumber: pr.number,
          ...(pr.url ? { prUrl: pr.url } : {}),
          ...(state ? { prState: state } : {}),
          ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
          ...(pr.author?.login ? { prAuthorLogin: pr.author.login } : {}),
        },
        "published PR verification refresh",
      );
      return state === "closed" ? "closed" : "open";
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        branchName: issue.branchName,
        repoFullName,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to verify published PR state after implementation");
      return "unknown";
    }
  }

  private upsertIssueIfLeaseHeld(
    projectId: string,
    linearIssueId: string,
    params: Parameters<PatchRelayDatabase["upsertIssue"]>[0],
    context: string,
  ): IssueRecord | undefined {
    const updated = this.withHeldLease(projectId, linearIssueId, (lease) =>
      this.db.issueSessions.upsertIssueWithLease(lease, params)
    );
    if (updated === undefined) {
      this.logger.warn({ projectId, linearIssueId, context }, "Skipping issue write after losing issue-session lease");
    }
    return updated;
  }

  private async describeLocalImplementationOutcome(
    issue: IssueRecord,
    baseBranch: string,
  ): Promise<string | undefined> {
    if (!issue.worktreePath) {
      return undefined;
    }

    try {
      const status = await execCommand(this.config.runner.gitBin, [
        "-C",
        issue.worktreePath,
        "status",
        "--short",
      ], { timeoutMs: 10_000 });
      const dirtyEntries = status.exitCode === 0
        ? status.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
        : [];
      if (dirtyEntries.length > 0) {
        return `Implementation completed without opening a PR; worktree still has ${dirtyEntries.length} uncommitted change(s)`;
      }
    } catch {
      // Best effort only.
    }

    try {
      const ahead = await execCommand(this.config.runner.gitBin, [
        "-C",
        issue.worktreePath,
        "rev-list",
        "--count",
        `origin/${baseBranch}..HEAD`,
      ], { timeoutMs: 10_000 });
      if (ahead.exitCode === 0) {
        const count = Number(ahead.stdout.trim());
        if (Number.isFinite(count) && count > 0) {
          return `Implementation completed with ${count} local commit(s) ahead of origin/${baseBranch} but no PR was observed`;
        }
      }
    } catch {
      // Best effort only.
    }

    return undefined;
  }
}
