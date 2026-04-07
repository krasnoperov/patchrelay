import type { GitHubPRApi, EvictionReporter } from "../interfaces.ts";
import type { CheckResult, IncidentRecord, PRStatus, QueueEntry } from "../types.ts";

interface SimPR {
  number: number;
  branch: string;
  headSha: string;
  merged: boolean;
  mergeStateStatus: string;
  reviewApproved: boolean;
  checks: CheckResult[];
  labels: string[];
}

/**
 * In-memory GitHub PR + checks simulator. Tracks PR state and check
 * results without hitting any real API.
 */
export class GitHubSim implements GitHubPRApi {
  private prs = new Map<number, SimPR>();

  /** Register a PR for simulation. */
  addPR(pr: { number: number; branch: string; headSha: string; reviewApproved?: boolean; labels?: string[] }): void {
    this.prs.set(pr.number, {
      number: pr.number,
      branch: pr.branch,
      headSha: pr.headSha,
      merged: false,
      mergeStateStatus: "CLEAN",
      reviewApproved: pr.reviewApproved ?? true,
      checks: [],
      labels: pr.labels ?? [],
    });
  }

  /** Set review approval state. */
  setReviewApproved(prNumber: number, approved: boolean): void {
    const pr = this.prs.get(prNumber);
    if (pr) pr.reviewApproved = approved;
  }

  /** Update head SHA (e.g., after force push). */
  updateSha(prNumber: number, sha: string): void {
    const pr = this.prs.get(prNumber);
    if (pr) {
      pr.headSha = sha;
      pr.mergeStateStatus = "CLEAN";
      pr.checks = [];
    }
  }

  setMergeStateStatus(prNumber: number, mergeStateStatus: string): void {
    const pr = this.prs.get(prNumber);
    if (pr) pr.mergeStateStatus = mergeStateStatus;
  }

  /** Set check results for a PR. */
  setChecks(prNumber: number, checks: CheckResult[]): void {
    const pr = this.prs.get(prNumber);
    if (pr) pr.checks = checks;
  }

  /** Called after mergePR to sync git state in tests. */
  onMerge: ((prNumber: number, branch: string) => Promise<void>) | null = null;

  async mergePR(prNumber: number): Promise<void> {
    const pr = this.prs.get(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found`);
    pr.merged = true;
    if (this.onMerge) await this.onMerge(prNumber, pr.branch);
  }

  async getStatus(prNumber: number): Promise<PRStatus> {
    const pr = this.prs.get(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found`);
    return {
      number: pr.number,
      branch: pr.branch,
      headSha: pr.headSha,
      mergeable: !pr.merged,
      mergeStateStatus: pr.mergeStateStatus,
      reviewApproved: pr.reviewApproved,
      merged: pr.merged,
    };
  }

  async listChecks(prNumber: number): Promise<CheckResult[]> {
    const pr = this.prs.get(prNumber);
    if (!pr) return [];
    return pr.checks;
  }

  /** Configurable main/ref checks for failure classification. */
  private refChecks = new Map<string, CheckResult[]>();

  setRefChecks(ref: string, checks: CheckResult[]): void {
    this.refChecks.set(ref, checks);
  }

  async listChecksForRef(ref: string): Promise<CheckResult[]> {
    // Strip origin/ prefix — matches production client behavior.
    const normalized = ref.replace(/^origin\//, "");
    return this.refChecks.get(normalized) ?? [];
  }

  async findPRByBranch(branch: string): Promise<number | null> {
    for (const pr of this.prs.values()) {
      if (pr.branch === branch && !pr.merged) return pr.number;
    }
    return null;
  }

  async listLabels(prNumber: number): Promise<string[]> {
    const pr = this.prs.get(prNumber);
    if (!pr) return [];
    return [...pr.labels];
  }

  async listOpenPRsWithLabel(_label: string): Promise<Array<{ number: number; branch: string; headSha: string }>> {
    return [];
  }

  async listOpenPRs(): Promise<Array<{ number: number; branch: string; headSha: string }>> {
    return [...this.prs.values()]
      .filter((pr) => !pr.merged)
      .map((pr) => ({ number: pr.number, branch: pr.branch, headSha: pr.headSha }));
  }

  async deleteBranch(_prNumber: number): Promise<void> {
    // No-op in sim — branch deletion is cosmetic cleanup.
  }

  /** Mark a PR as merged by branch name (used when push-to-main includes PR commits). */
  markMergedByBranch(branch: string): void {
    for (const pr of this.prs.values()) {
      if (pr.branch === branch && !pr.merged) {
        pr.merged = true;
      }
    }
  }

  /** Add a label to a PR. */
  addLabel(prNumber: number, label: string): void {
    const pr = this.prs.get(prNumber);
    if (pr && !pr.labels.includes(label)) pr.labels.push(label);
  }

  /** Remove a label from a PR. */
  removeLabel(prNumber: number, label: string): void {
    const pr = this.prs.get(prNumber);
    if (pr) pr.labels = pr.labels.filter((l) => l !== label);
  }
}

/**
 * In-memory eviction reporter that records evictions for test assertion.
 */
export class EvictionReporterSim implements EvictionReporter {
  readonly evictions: Array<{ entry: QueueEntry; incident: IncidentRecord }> = [];

  async reportEviction(entry: QueueEntry, incident: IncidentRecord): Promise<void> {
    this.evictions.push({ entry: { ...entry }, incident: { ...incident } });
  }
}
