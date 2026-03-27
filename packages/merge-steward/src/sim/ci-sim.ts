import type { CIRunner } from "../interfaces.ts";
import type { CIStatus } from "../types.ts";

/**
 * Rule function that determines CI pass/fail based on the set of files
 * present on the branch. Receives file paths and returns the CI result.
 */
export type CIRule = (files: string[]) => CIStatus;

interface CIRun {
  id: string;
  branch: string;
  sha: string;
  status: CIStatus;
  cancelled: boolean;
}

/**
 * Deterministic CI simulator. Pass/fail is determined by a rule function
 * applied to the files changed on the branch. Results are instant (no
 * async delay) — the harness controls when results are observed.
 */
export class CISim implements CIRunner {
  private runs = new Map<string, CIRun>();
  private nextId = 1;
  private readonly rule: CIRule;

  /** All runs triggered, for test inspection. */
  get allRuns(): ReadonlyMap<string, CIRun> {
    return this.runs;
  }

  get runCount(): number {
    return this.runs.size;
  }

  constructor(rule: CIRule) {
    this.rule = rule;
  }

  /**
   * Resolve changed files for a run. The harness must inject this
   * function since the CI sim doesn't own the git layer.
   */
  resolveFiles: ((branch: string, sha: string) => Promise<string[]>) | null = null;

  async triggerRun(branch: string, sha: string): Promise<string> {
    const id = `ci-${this.nextId++}`;
    const files = this.resolveFiles ? await this.resolveFiles(branch, sha) : [];
    const status = this.rule(files);
    this.runs.set(id, { id, branch, sha, status, cancelled: false });
    return id;
  }

  async getStatus(runId: string): Promise<CIStatus> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown CI run: ${runId}`);
    if (run.cancelled) return "fail";
    return run.status;
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run) run.cancelled = true;
  }
}
