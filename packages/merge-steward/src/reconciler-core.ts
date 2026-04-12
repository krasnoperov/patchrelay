import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, ReconcileEvent, ReconcileAction } from "./types.ts";

export interface ReconcileContext {
  store: QueueStore;
  repoId: string;
  baseBranch: string;
  requiredChecks: string[];
  remotePrefix: string;
  git: GitOperations;
  ci: CIRunner;
  github: GitHubPRApi;
  eviction: EvictionReporter;
  specBuilder: SpeculativeBranchBuilder;
  speculativeDepth: number;
  flakyRetries: number;
  onEvent: (event: ReconcileEvent) => void;
}

export const SPEC_BRANCH_PREFIX = "mq-spec-";
export const FAILED_CONCLUSIONS = new Set<string>(["failure"]);
export const CLEAN_SPEC = { specBranch: null, specSha: null, specBasedOn: null } as const;
export const CLEAN_CI = { ciRunId: null, ciRetries: 0 } as const;

export function emit(ctx: ReconcileContext, entry: QueueEntry, action: ReconcileAction, extra?: Partial<ReconcileEvent>): void {
  ctx.onEvent({ at: new Date().toISOString(), entryId: entry.id, prNumber: entry.prNumber, action, ...extra });
}

export function ref(ctx: ReconcileContext, name: string): string {
  return ctx.remotePrefix + name;
}

export function specBranchName(entryId: string): string {
  return `${SPEC_BRANCH_PREFIX}${entryId}`;
}

export function isBudgetExhausted(entry: QueueEntry): boolean {
  return entry.retryAttempts >= entry.maxRetries;
}

export function isRetryGated(entry: QueueEntry, currentBaseSha: string): boolean {
  return entry.lastFailedBaseSha === currentBaseSha;
}
