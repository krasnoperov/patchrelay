import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { GitHubPolicyCache } from "./github-policy.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, ReconcileEvent, ReconcileAction } from "./types.ts";

export interface ReconcileContext {
  store: QueueStore;
  repoId: string;
  baseBranch: string;
  remotePrefix: string;
  git: GitOperations;
  ci: CIRunner;
  github: GitHubPRApi;
  eviction: EvictionReporter;
  specBuilder: SpeculativeBranchBuilder;
  speculativeDepth: number;
  flakyRetries: number;
  policy: GitHubPolicyCache;
  /** Queue sub-state label names. When set, the reconciler keeps the
   * `testing`/`merging` labels on each PR in sync with its phase so the
   * queue position is visible on GitHub. Omit to disable label sync. */
  queueStateLabels?: { testing: string; merging: string };
  onEvent: (event: ReconcileEvent) => void;
}

export const CANDIDATE_REF_PREFIX = "mq-spec-";
export const FAILED_CONCLUSIONS = new Set<string>(["failure"]);
export const CLEAR_CANDIDATE = {
  candidateKind: null,
  candidatePolicyFingerprint: null,
  candidateRef: null,
  candidateSha: null,
  candidateBasedOn: null,
} as const;
/** Remove only the ephemeral remote/dependency ref while retaining candidate audit identity. */
export const CLEAN_CANDIDATE_REF = { candidateRef: null, candidateBasedOn: null } as const;
export const CLEAN_CI = { ciRunId: null, ciRetries: 0 } as const;

export function emit(ctx: ReconcileContext, entry: QueueEntry, action: ReconcileAction, extra?: Partial<ReconcileEvent>): void {
  ctx.onEvent({ at: new Date().toISOString(), entryId: entry.id, prNumber: entry.prNumber, action, ...extra });
}

export function ref(ctx: ReconcileContext, name: string): string {
  return ctx.remotePrefix + name;
}

export function candidateRefName(entryId: string): string {
  return `${CANDIDATE_REF_PREFIX}${entryId}`;
}

export function isBudgetExhausted(entry: QueueEntry): boolean {
  return entry.retryAttempts >= entry.maxRetries;
}

export function isRetryGated(entry: QueueEntry, currentBaseSha: string): boolean {
  return entry.lastFailedBaseSha === currentBaseSha;
}
