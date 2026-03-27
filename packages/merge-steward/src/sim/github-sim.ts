import type { GitHubPRApi, RepairDispatcher } from "../interfaces.ts";
import type { CheckConclusion, CheckResult, PRStatus, QueueRepairContext } from "../types.ts";

interface SimPR {
  number: number;
  branch: string;
  headSha: string;
  merged: boolean;
  reviewApproved: boolean;
  checks: CheckResult[];
}

/**
 * In-memory GitHub PR + checks simulator. Tracks PR state and check
 * results without hitting any real API.
 */
export class GitHubSim implements GitHubPRApi {
  private prs = new Map<number, SimPR>();

  /** Register a PR for simulation. */
  addPR(pr: { number: number; branch: string; headSha: string; reviewApproved?: boolean }): void {
    this.prs.set(pr.number, {
      number: pr.number,
      branch: pr.branch,
      headSha: pr.headSha,
      merged: false,
      reviewApproved: pr.reviewApproved ?? true,
      checks: [],
    });
  }

  /** Set review approval state. */
  setReviewApproved(prNumber: number, approved: boolean): void {
    const pr = this.prs.get(prNumber);
    if (pr) pr.reviewApproved = approved;
  }

  /** Update head SHA (e.g., after rebase/push). */
  updateSha(prNumber: number, sha: string): void {
    const pr = this.prs.get(prNumber);
    if (pr) {
      pr.headSha = sha;
      pr.checks = []; // checks reset on new SHA
    }
  }

  /** Set check results for a PR. */
  setChecks(prNumber: number, checks: CheckResult[]): void {
    const pr = this.prs.get(prNumber);
    if (pr) pr.checks = checks;
  }

  async mergePR(prNumber: number): Promise<void> {
    const pr = this.prs.get(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found`);
    pr.merged = true;
  }

  async getStatus(prNumber: number): Promise<PRStatus> {
    const pr = this.prs.get(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found`);
    return {
      number: pr.number,
      branch: pr.branch,
      headSha: pr.headSha,
      mergeable: !pr.merged,
      reviewApproved: pr.reviewApproved,
      merged: pr.merged,
    };
  }

  async listChecks(prNumber: number): Promise<CheckResult[]> {
    const pr = this.prs.get(prNumber);
    if (!pr) return [];
    return pr.checks;
  }
}

/**
 * In-memory repair dispatcher that records requests for test assertion.
 */
export class RepairSim implements RepairDispatcher {
  readonly requests: QueueRepairContext[] = [];
  readonly cancellations: string[] = [];

  /** Configurable auto-resolve: if set, repair "completes" immediately. */
  autoResolve: boolean = false;

  async requestRepair(context: QueueRepairContext): Promise<void> {
    this.requests.push(context);
  }

  async cancelRepair(queueEntryId: string): Promise<void> {
    this.cancellations.push(queueEntryId);
  }
}
