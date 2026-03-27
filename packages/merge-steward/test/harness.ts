import git from "isomorphic-git";
import { GitSim } from "../src/sim/git-sim.ts";
import { CISim, type CIRule } from "../src/sim/ci-sim.ts";
import { GitHubSim, RepairSim } from "../src/sim/github-sim.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { reconcile, completeRepair } from "../src/reconciler.ts";
import type { ReconcileContext } from "../src/reconciler.ts";
import type { QueueEntry, QueueEntryStatus } from "../src/types.ts";
import { TERMINAL_STATUSES } from "../src/types.ts";
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
 * Test harness that wires GitSim + CISim + GitHubSim + MemoryStore
 * together with the reconciler under test.
 */
export class Harness {
  readonly gitSim: GitSim;
  readonly ciSim: CISim;
  readonly githubSim: GitHubSim;
  readonly repairSim: RepairSim;
  readonly store: MemoryStore;

  /** All entry IDs ever created — for no-loss invariant. */
  readonly allEntryIds: Set<string> = new Set();

  /** PRs merged to main in order. */
  readonly mergedPRs: number[] = [];

  /** Whether main has ever had a bad merge. */
  mainGreen = true;

  private readonly baseBranch: string;
  private readonly repoId = "test-repo";
  private readonly flakyRetries: number;
  private readonly repairBudget: number;
  private readonly autoCompleteRepairs: boolean;
  private nextPosition = 1;
  private nextEntryId = 1;
  private tickCount = 0;

  /**
   * The reconciler function — the thing under test.
   * Defaults to the real reconciler implementation.
   */
  reconcileFn:
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
    this.store = new MemoryStore();

    this.ciSim.resolveFiles = async (branch: string) => {
      try {
        return await this.gitSim.changedFiles(branch, this.baseBranch);
      } catch {
        return [];
      }
    };

    // Sync GitHubSim SHA when git pushes (needed for revalidation).
    this.gitSim.onPush = (branch: string, sha: string) => {
      for (const entry of this.store.listAll(this.repoId)) {
        if (entry.branch === branch) {
          this.githubSim.updateSha(entry.prNumber, sha);
        }
      }
    };
  }

  async init(): Promise<void> {
    await this.gitSim.init(this.baseBranch);
  }

  /**
   * Create a PR branch with files and enqueue it.
   */
  async enqueue(pr: SimPR): Promise<QueueEntry> {
    await this.gitSim.createBranch(pr.branch, this.baseBranch);
    await git.checkout({
      fs: this.gitSim.volume,
      dir: this.gitSim.repoDir,
      ref: pr.branch,
      force: true,
    });

    for (const file of pr.files) {
      await this.gitSim.commitFile(file.path, file.content, `add ${file.path}`);
    }

    await git.checkout({
      fs: this.gitSim.volume,
      dir: this.gitSim.repoDir,
      ref: this.baseBranch,
      force: true,
    });

    const headSha = await this.gitSim.headSha(pr.branch);
    const baseSha = await this.gitSim.headSha(this.baseBranch);

    this.githubSim.addPR({
      number: pr.number,
      branch: pr.branch,
      headSha,
      reviewApproved: true,
    });

    const entry: QueueEntry = {
      id: `qe-${this.nextEntryId++}`,
      repoId: this.repoId,
      prNumber: pr.number,
      branch: pr.branch,
      headSha,
      baseSha,
      status: "queued",
      position: this.nextPosition++,
      priority: 0,
      generation: 0,
      ciRunId: null,
      ciRetries: 0,
      repairAttempts: 0,
      maxRepairAttempts: this.repairBudget,
      issueKey: null,
      worktreePath: null,
      enqueuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.store.insert(entry);
    this.allEntryIds.add(entry.id);
    return entry;
  }

  /** Run one reconciliation tick. */
  async tick(): Promise<void> {
    this.tickCount++;
    if (!this.reconcileFn) return;

    if (this.autoCompleteRepairs) {
      for (const entry of this.store.listActive(this.repoId)) {
        if (entry.status === "repair_in_progress") {
          completeRepair(this.store, entry.id);
        }
      }
    }

    await this.reconcileFn(this.buildContext());
  }

  /**
   * Manually complete a repair for a specific entry.
   * Use with autoCompleteRepairs: false to control repair timing.
   */
  completeRepair(queueEntryId: string): boolean {
    return completeRepair(this.store, queueEntryId);
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

  /** All entries (view from store). */
  get entries(): QueueEntry[] {
    return this.store.listAll(this.repoId);
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
    return this.store.listActive(this.repoId);
  }

  /** Repair requests dispatched to PatchRelay. */
  get repairRequests() {
    return this.repairSim.requests;
  }

  /** Simulate a process crash + restart — reset transient state. */
  restart(): void {
    this.tickCount = 0;
  }

  // --- Internal helpers ---

  private buildContext(): ReconcileContext {
    return {
      store: this.store,
      repoId: this.repoId,
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
      (e) => !TERMINAL_STATUSES.includes(e.status) && e.status !== "paused",
    );
  }
}

/**
 * Convenience factory for tests.
 */
export async function createHarness(options?: HarnessOptions): Promise<Harness> {
  const h = new Harness(options);
  await h.init();
  return h;
}
