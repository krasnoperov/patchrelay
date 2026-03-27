import git from "isomorphic-git";
import { GitSim } from "../src/sim/git-sim.ts";
import { CISim, type CIRule } from "../src/sim/ci-sim.ts";
import { GitHubSim, RepairSim } from "../src/sim/github-sim.ts";
import { reconcile, completeRepair } from "../src/reconciler.ts";
import type { QueueEntry, QueueEntryStatus, CIStatus } from "../src/types.ts";
import { assertInvariants } from "./invariants.ts";

export interface SimPR {
  number: number;
  branch: string;
  files: Array<{ path: string; content: string }>;
}

export interface HarnessOptions {
  baseBranch?: string;
  ciRule?: CIRule;
  flakyRetries?: number;
  repairBudget?: number;
  /**
   * When true (default), the harness automatically completes any
   * repair_in_progress entry before each tick, simulating instant
   * PatchRelay repair. Set to false to manually control repair timing
   * via completeRepair().
   */
  autoCompleteRepairs?: boolean;
}

/**
 * Test harness that wires GitSim + CISim + GitHubSim together with a
 * queue under test. Provides enqueue/tick/runUntilStable for scenario
 * tests and assertInvariants for correctness checking.
 *
 * The reconciler is pluggable — initially null (tests will fail),
 * replaced with the real implementation as it's built.
 */
export class Harness {
  readonly gitSim: GitSim;
  readonly ciSim: CISim;
  readonly githubSim: GitHubSim;
  readonly repairSim: RepairSim;

  /** All queue entries, past and present. */
  readonly entries: QueueEntry[] = [];

  /** All entry IDs ever created — for no-loss invariant. */
  readonly allEntryIds: Set<string> = new Set();

  /** PRs merged to main in order. */
  readonly mergedPRs: number[] = [];

  /** Whether main has ever had a bad merge. */
  mainGreen = true;

  /** Previous tick snapshot for monotonic progress detection. */
  private previousSnapshot: string | null = null;
  private staleTicks = 0;

  private readonly baseBranch: string;
  private readonly flakyRetries: number;
  private readonly repairBudget: number;
  private readonly autoCompleteRepairs: boolean;
  private nextPosition = 1;
  private nextEntryId = 1;
  private tickCount = 0;

  /**
   * The reconciler function — the thing under test.
   * Defaults to the real reconciler implementation.
   * Set to null to test harness behavior without a reconciler.
   */
  reconcile:
    | ((ctx: ReconcileContext) => Promise<void>)
    | null = reconcile;

  constructor(options: HarnessOptions = {}) {
    this.baseBranch = options.baseBranch ?? "main";
    this.flakyRetries = options.flakyRetries ?? 0;
    this.repairBudget = options.repairBudget ?? 3;
    this.autoCompleteRepairs = options.autoCompleteRepairs ?? true;

    this.gitSim = new GitSim();
    this.ciSim = new CISim(options.ciRule ?? (() => "pass"));
    this.githubSim = new GitHubSim();
    this.repairSim = new RepairSim();

    // Wire CI sim to resolve files from git sim.
    this.ciSim.resolveFiles = async (branch: string) => {
      try {
        return await this.gitSim.changedFiles(branch, this.baseBranch);
      } catch {
        return [];
      }
    };
  }

  /** Initialize the repo and base branch. */
  async init(): Promise<void> {
    await this.gitSim.init(this.baseBranch);
  }

  /**
   * Create a PR branch with files and enqueue it.
   * Simulates: developer created a branch, pushed it, opened a PR,
   * got it approved with green branch CI.
   */
  async enqueue(pr: SimPR): Promise<QueueEntry> {
    // Create branch from current main.
    await this.gitSim.createBranch(pr.branch, this.baseBranch);
    await git.checkout({
      fs: this.gitSim.volume,
      dir: this.gitSim.repoDir,
      ref: pr.branch,
      force: true,
    });

    // Commit files.
    for (const file of pr.files) {
      await this.gitSim.commitFile(file.path, file.content, `add ${file.path}`);
    }

    // Switch back to base.
    await git.checkout({
      fs: this.gitSim.volume,
      dir: this.gitSim.repoDir,
      ref: this.baseBranch,
      force: true,
    });

    const headSha = await this.gitSim.headSha(pr.branch);
    const baseSha = await this.gitSim.headSha(this.baseBranch);

    // Register in GitHub sim.
    this.githubSim.addPR({
      number: pr.number,
      branch: pr.branch,
      headSha,
      reviewApproved: true,
    });

    // Create queue entry.
    const entry: QueueEntry = {
      id: `qe-${this.nextEntryId++}`,
      repoId: "test-repo",
      prNumber: pr.number,
      branch: pr.branch,
      headSha,
      baseSha,
      status: "queued",
      position: this.nextPosition++,
      priority: 0,
      ciRunId: null,
      ciRetries: 0,
      repairAttempts: 0,
      maxRepairAttempts: this.repairBudget,
      enqueuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.allEntryIds.add(entry.id);
    return entry;
  }

  /** Run one reconciliation tick. */
  async tick(): Promise<void> {
    this.tickCount++;
    if (!this.reconcile) return;

    // If auto-complete is on, resolve any repair_in_progress entries
    // before the reconciler runs (simulates PatchRelay completing repair
    // between ticks).
    if (this.autoCompleteRepairs) {
      for (const entry of this.entries) {
        if (entry.status === "repair_in_progress") {
          completeRepair(this.entries, entry.id);
        }
      }
    }

    await this.reconcile(this.buildContext());
  }

  /**
   * Manually complete a repair for a specific entry.
   * Use with autoCompleteRepairs: false to control repair timing.
   */
  completeRepair(queueEntryId: string): boolean {
    return completeRepair(this.entries, queueEntryId);
  }

  /** Run ticks until no more progress or maxTicks reached. */
  async runUntilStable(options?: { maxTicks?: number }): Promise<void> {
    const max = options?.maxTicks ?? 100;
    for (let i = 0; i < max; i++) {
      const before = this.snapshotStatuses();
      await this.tick();
      const after = this.snapshotStatuses();
      if (before === after && !this.hasActiveWork()) break;
    }
  }

  /** Assert all 6 invariants. */
  assertInvariants(): void {
    assertInvariants(this.entries, this.mergedPRs, this.mainGreen, this.allEntryIds);
  }

  /** Get the status of a specific entry by PR number. */
  entryStatus(pr: SimPR): QueueEntryStatus | undefined {
    return this.entries.find((e) => e.prNumber === pr.number)?.status;
  }

  /** Get merged PR numbers in merge order. */
  get merged(): number[] {
    return [...this.mergedPRs];
  }

  /** Get evicted PR numbers. */
  get evicted(): number[] {
    return this.entries.filter((e) => e.status === "evicted").map((e) => e.prNumber);
  }

  /** Get entries still active (not terminal). */
  get activeEntries(): QueueEntry[] {
    return this.entries.filter(
      (e) => e.status !== "merged" && e.status !== "evicted",
    );
  }

  /** Repair requests dispatched to PatchRelay. */
  get repairRequests() {
    return this.repairSim.requests;
  }

  /** Simulate a process crash + restart — reset transient state. */
  restart(): void {
    // The reconciler should be idempotent — restarting and re-running
    // should converge to the same state. Entries persist (they're the "DB").
    this.tickCount = 0;
  }

  // --- Internal helpers ---

  private buildContext(): ReconcileContext {
    return {
      entries: this.entries,
      baseBranch: this.baseBranch,
      git: this.gitSim,
      ci: this.ciSim,
      github: this.githubSim,
      repair: this.repairSim,
      flakyRetries: this.flakyRetries,
      onMerged: (prNumber: number) => {
        this.mergedPRs.push(prNumber);
      },
      onMainBroken: () => {
        this.mainGreen = false;
      },
    };
  }

  private snapshotStatuses(): string {
    return this.entries.map((e) => `${e.prNumber}:${e.status}`).join(",");
  }

  private hasActiveWork(): boolean {
    return this.entries.some(
      (e) =>
        e.status !== "merged" &&
        e.status !== "evicted" &&
        e.status !== "paused",
    );
  }
}

/**
 * Context passed to the reconciler on each tick.
 */
export interface ReconcileContext {
  entries: QueueEntry[];
  baseBranch: string;
  git: GitSim;
  ci: CISim;
  github: GitHubSim;
  repair: RepairSim;
  flakyRetries: number;
  onMerged: (prNumber: number) => void;
  onMainBroken: () => void;
}

/**
 * Convenience factory for tests.
 */
export async function createHarness(options?: HarnessOptions): Promise<Harness> {
  const h = new Harness(options);
  await h.init();
  return h;
}
