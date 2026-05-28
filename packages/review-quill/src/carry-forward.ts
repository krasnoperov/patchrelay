import type { Logger } from "pino";
import type { GitHubClient } from "./github-client.ts";
import type { SqliteStore } from "./db/sqlite-store.ts";
import type {
  PullRequestSummary,
  ReviewAttemptRecord,
  ReviewQuillRepositoryConfig,
  ReviewSurfaceMode,
} from "./types.ts";
import { gitMergeBase, gitMergeTree, gitPatchId } from "./review-workspace/git.ts";
import { isStackedPullRequest, materializeReviewWorkspace } from "./review-workspace/materialize.ts";
import { buildPromptFingerprint } from "./prompt-fingerprint.ts";

// Default opt-out label. A PR carrying this label always re-runs the
// reviewer instead of being served from the carry-forward cache —
// useful for release / changelog PRs where the body needs a fresh
// rendering even when the diff is byte-identical.
export const DEFAULT_NO_CACHE_LABEL = "review:no-cache";

// Plan §3.4: `head` is the safe default — reviewer reads the PR head,
// carry-forward cache keys on patch_id alone, trivial rebases carry
// forward. `integration_tree` is opt-in: reviewer reads a synthetic
// merge commit (so file reads see what would actually land), the
// cache key includes the integration_tree_id, semantic merge issues
// are caught at review time at the cost of more re-reviews when main
// advances.
export const DEFAULT_REVIEW_SURFACE_MODE: ReviewSurfaceMode = "head";

export function resolveNoCacheLabel(repo: ReviewQuillRepositoryConfig): string {
  return repo.noCacheLabel ?? DEFAULT_NO_CACHE_LABEL;
}

export function resolveReviewSurfaceMode(repo: ReviewQuillRepositoryConfig): ReviewSurfaceMode {
  return repo.reviewSurfaceMode ?? DEFAULT_REVIEW_SURFACE_MODE;
}

export interface ChangeIdentity {
  patchId: string;
  baseSha: string;
  mode: ReviewSurfaceMode;
  // Reserved for integration_tree mode (deferred).
  integrationTreeId?: string;
}

export type CarryForwardResult =
  | { kind: "carried_forward"; attempt: ReviewAttemptRecord }
  | { kind: "no_candidate"; identity?: ChangeIdentity }
  | { kind: "skipped"; reason: "stacked_pr" | "no_cache_label" | "no_token" | "identity_unavailable" };

interface CarryForwardDeps {
  store: SqliteStore;
  github: GitHubClient;
  logger: Logger;
}

// Compute the change identity for a PR head against the configured base.
//
// Returns `undefined` for any case where carry-forward should not engage:
//   - stacked PR (base ref differs from repo default — v1 does not yet
//     resolve parent PR heads as the diff base, see plan §3.2 / §8.6).
//   - failed materialization or git failure.
//   - empty diff (PR with no changes; nothing to carry forward).
//
// The caller is responsible for disposing the workspace this routine
// materializes; identity is computed and the workspace returned so a
// fresh review can reuse it on cache miss.
export async function computeChangeIdentity(
  repo: ReviewQuillRepositoryConfig,
  pr: PullRequestSummary,
  github: GitHubClient,
  logger: Logger,
): Promise<{ identity: ChangeIdentity; dispose: () => Promise<void> } | undefined> {
  if (isStackedPullRequest(pr, repo.baseBranch)) {
    logger.debug({
      repo: repo.repoFullName,
      prNumber: pr.number,
      baseRefName: pr.baseRefName,
      repoBaseBranch: repo.baseBranch,
    }, "Skipping carry-forward identity for stacked PR (parent-ref base resolution not in v1)");
    return undefined;
  }

  const token = github.currentTokenForRepo(repo.repoFullName);
  if (!token) {
    logger.warn({
      repo: repo.repoFullName,
      prNumber: pr.number,
    }, "No GitHub token available for carry-forward identity");
    return undefined;
  }

  let materialized: Awaited<ReturnType<typeof materializeReviewWorkspace>>;
  try {
    materialized = await materializeReviewWorkspace({
      repoFullName: repo.repoFullName,
      baseBranch: repo.baseBranch,
      pr,
      token,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({
      repo: repo.repoFullName,
      prNumber: pr.number,
      headSha: pr.headSha,
      error: message,
    }, "Failed to materialize workspace for carry-forward identity");
    return undefined;
  }

  try {
    const baseSha = await gitMergeBase(materialized.workspace.worktreePath, materialized.workspace.baseRef, pr.headSha);
    const patchId = await gitPatchId(materialized.workspace.worktreePath, materialized.workspace.baseRef, pr.headSha);
    if (!patchId) {
      // Empty diff — the PR has no change content. No identity to cache.
      await materialized.dispose();
      return undefined;
    }
    const mode = resolveReviewSurfaceMode(repo);
    let integrationTreeId: string | undefined;
    if (mode === "integration_tree") {
      // Plan §3.4: cache key for integration_tree mode is
      // (patch_id, integration_tree_id). The merged tree changes
      // when the base advances even if the PR diff is unchanged, so
      // the second key is necessary to avoid stale carry-forwards.
      const merge = await gitMergeTree(
        materialized.workspace.worktreePath,
        baseSha,
        pr.headSha,
      ).catch(() => undefined);
      if (merge && !merge.conflict) {
        integrationTreeId = merge.treeId;
      }
    }
    const identity: ChangeIdentity = {
      patchId,
      baseSha,
      mode,
      ...(integrationTreeId ? { integrationTreeId } : {}),
    };
    return { identity, dispose: materialized.dispose };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({
      repo: repo.repoFullName,
      prNumber: pr.number,
      headSha: pr.headSha,
      error: message,
    }, "Failed to compute change identity for carry-forward");
    await materialized.dispose();
    return undefined;
  }
}

// Pure-logic candidate lookup. Mode controls which index we hit; the
// integration_tree path requires both patch_id and integration_tree_id
// (the latter is never populated in v1, so this branch never fires
// today, but the lookup is wired for the deferred opt-in path).
export function lookupCarryForwardCandidate(
  repo: ReviewQuillRepositoryConfig,
  prNumber: number,
  identity: ChangeIdentity,
  store: SqliteStore,
  promptFingerprint?: string,
): ReviewAttemptRecord | undefined {
  if (identity.mode === "head") {
    return store.findApprovedAttemptByPatchId(repo.repoFullName, prNumber, identity.patchId, "head", promptFingerprint);
  }
  if (!identity.integrationTreeId) return undefined;
  return store.findApprovedAttemptByPatchAndTree(
    repo.repoFullName,
    prNumber,
    identity.patchId,
    identity.integrationTreeId,
    "integration_tree",
    promptFingerprint,
  );
}

// Re-emit a prior approved verdict on the new head SHA and insert a new
// attempt row pointing at the original. Caller must verify that the
// candidate has the body/event fields populated (rollout safety) — this
// function trusts what it receives.
export async function republishCarryForward(
  repo: ReviewQuillRepositoryConfig,
  pr: PullRequestSummary,
  candidate: ReviewAttemptRecord,
  identity: ChangeIdentity,
  deps: CarryForwardDeps,
): Promise<ReviewAttemptRecord> {
  if (!candidate.reviewBody || !candidate.reviewEvent) {
    throw new Error(`republishCarryForward requires reviewBody and reviewEvent (attempt ${candidate.id})`);
  }

  deps.logger.info({
    repo: repo.repoFullName,
    prNumber: pr.number,
    headSha: pr.headSha,
    priorAttemptId: candidate.id,
    priorHeadSha: candidate.headSha,
    patchId: identity.patchId,
    mode: identity.mode,
  }, "Carry-forward cache hit; re-emitting prior verdict on new head");

  // Re-publish against the new head SHA. GitHub anchors review state
  // to the SHA, so the new head needs its own review row even when
  // body/event are byte-identical to the prior approval.
  await deps.github.submitReview(repo.repoFullName, pr.number, {
    event: candidate.reviewEvent,
    body: candidate.reviewBody,
    commitId: pr.headSha,
  });

  return deps.store.createAttempt({
    repoFullName: repo.repoFullName,
    prNumber: pr.number,
    headSha: pr.headSha,
    status: "completed",
    conclusion: "approved",
    ...(pr.title ? { prTitle: pr.title } : {}),
    promptFingerprint: buildPromptFingerprint(pr),
    patchId: identity.patchId,
    ...(identity.integrationTreeId ? { integrationTreeId: identity.integrationTreeId } : {}),
    reviewSurfaceMode: identity.mode,
    baseSha: identity.baseSha,
    priorAttemptId: candidate.id,
    reviewBody: candidate.reviewBody,
    reviewEvent: candidate.reviewEvent,
    publicationMode: candidate.publicationMode ?? "body_only",
    summary: `Carry-forward of attempt #${candidate.id} (same patch-id ${identity.patchId.slice(0, 12)}…)`,
    completedAt: new Date().toISOString(),
  });
}

// Try to serve a fresh review from the carry-forward cache. On hit:
// re-emit the stored verdict against the new head SHA and insert a new
// attempt row pointing at the original. On miss: surface the identity so
// the caller can populate it on the row produced by a fresh review run.
export async function tryCarryForward(
  repo: ReviewQuillRepositoryConfig,
  pr: PullRequestSummary,
  deps: CarryForwardDeps,
): Promise<CarryForwardResult> {
  const noCacheLabel = resolveNoCacheLabel(repo);
  if (pr.labels.some((label) => label.toLowerCase() === noCacheLabel.toLowerCase())) {
    deps.logger.info({
      repo: repo.repoFullName,
      prNumber: pr.number,
      label: noCacheLabel,
    }, "Skipping carry-forward; PR carries the no-cache label");
    return { kind: "skipped", reason: "no_cache_label" };
  }

  const computed = await computeChangeIdentity(repo, pr, deps.github, deps.logger);
  if (!computed) {
    return { kind: "skipped", reason: "identity_unavailable" };
  }

  try {
    const { identity } = computed;
    const candidate = lookupCarryForwardCandidate(repo, pr.number, identity, deps.store, buildPromptFingerprint(pr));
    if (!candidate || !candidate.reviewBody || !candidate.reviewEvent) {
      return { kind: "no_candidate", identity };
    }
    const inserted = await republishCarryForward(repo, pr, candidate, identity, deps);
    return { kind: "carried_forward", attempt: inserted };
  } finally {
    await computed.dispose();
  }
}
