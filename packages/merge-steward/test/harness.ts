import git from "isomorphic-git";
import { GitSim } from "../src/sim/git-sim.ts";
import { CISim, type CIRule } from "../src/sim/ci-sim.ts";
import { GitHubSim, EvictionReporterSim } from "../src/sim/github-sim.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { reconcile } from "../src/reconciler.ts";
import type { ReconcileContext } from "../src/reconciler.ts";
import type { QueueEntry, QueueEntryStatus, EvictionContext } from "../src/types.ts";
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
  maxRetries?: number;
}

export class Harness {
  readonly gitSim: GitSim;
  readonly ciSim: CISim;
  readonly githubSim: GitHubSim;
  readonly evictionSim: EvictionReporterSim;
  readonly store: MemoryStore;

  readonly allEntryIds: Set<string> = new Set();
  readonly mergedPRs: number[] = [];
  mainGreen = true;

  private readonly baseBranch: string;
  private readonly repoId = "test-repo";
  private readonly flakyRetries: number;
  private readonly maxRetries: number;
  private nextPosition = 1;
  private nextEntryId = 1;
  private tickCount = 0;

  reconcileFn:
    | ((ctx: ReconcileContext) => Promise<void>)
    | null = reconcile;

  constructor(options: HarnessOptions = {}) {
    this.baseBranch = options.baseBranch ?? "main";
    this.flakyRetries = options.flakyRetries ?? 0;
    this.maxRetries = options.maxRetries ?? 3;

    this.gitSim = new GitSim();
    this.ciSim = new CISim(options.ciRule ?? (() => "pass"));
    this.githubSim = new GitHubSim();
    this.evictionSim = new EvictionReporterSim();
    this.store = new MemoryStore();

    this.ciSim.resolveFiles = async (branch: string) => {
      try {
        return await this.gitSim.changedFiles(branch, this.baseBranch);
      } catch {
        return [];
      }
    };

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
      retryAttempts: 0,
      maxRetries: this.maxRetries,
      lastFailedBaseSha: null,
      issueKey: null,
      worktreePath: null,
      enqueuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.store.insert(entry);
    this.allEntryIds.add(entry.id);
    return entry;
  }

  async tick(): Promise<void> {
    this.tickCount++;
    if (!this.reconcileFn) return;
    await this.reconcileFn(this.buildContext());
  }

  async runUntilStable(options?: { maxTicks?: number }): Promise<void> {
    const max = options?.maxTicks ?? 100;
    for (let i = 0; i < max; i++) {
      const before = this.snapshotStatuses();
      await this.tick();
      const after = this.snapshotStatuses();
      if (before === after && !this.hasActiveWork()) break;
    }
  }

  assertInvariants(): void {
    assertInvariants(this.entries, this.mergedPRs, this.mainGreen, this.allEntryIds);
  }

  get entries(): QueueEntry[] {
    return this.store.listAll(this.repoId);
  }

  entryStatus(pr: SimPR): QueueEntryStatus | undefined {
    return this.entries.find((e) => e.prNumber === pr.number)?.status;
  }

  get merged(): number[] {
    return [...this.mergedPRs];
  }

  get evicted(): number[] {
    return this.entries.filter((e) => e.status === "evicted").map((e) => e.prNumber);
  }

  get activeEntries(): QueueEntry[] {
    return this.store.listActive(this.repoId);
  }

  get evictions() {
    return this.evictionSim.evictions;
  }

  restart(): void {
    this.tickCount = 0;
  }

  private buildContext(): ReconcileContext {
    return {
      store: this.store,
      repoId: this.repoId,
      baseBranch: this.baseBranch,
      git: this.gitSim,
      ci: this.ciSim,
      github: this.githubSim,
      eviction: this.evictionSim,
      flakyRetries: this.flakyRetries,
      onMerged: (prNumber: number) => {
        this.mergedPRs.push(prNumber);
      },
      onEvicted: (_prNumber: number, _context: EvictionContext) => {},
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

export async function createHarness(options?: HarnessOptions): Promise<Harness> {
  const h = new Harness(options);
  await h.init();
  return h;
}
