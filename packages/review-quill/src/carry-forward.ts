import type { Logger } from "pino";
import type { GitHubClient } from "./github-client.ts";
import type { SqliteStore } from "./db/sqlite-store.ts";
import type {
  PullRequestSummary,
  ReviewAttemptRecord,
  ReviewQuillRepositoryConfig,
  ReviewWorkspace,
} from "./types.ts";
import { gitPatchId } from "./review-workspace/git.ts";
import { materializeReviewWorkspace } from "./review-workspace/materialize.ts";
import { buildPromptFingerprint } from "./prompt-fingerprint.ts";
import { classifyPublicationDisposition } from "./review-publication-policy.ts";

// Default opt-out label. A PR carrying this label always re-runs the
// reviewer instead of being served from the carry-forward cache —
// useful for release / changelog PRs where the body needs a fresh
// rendering even when the diff is byte-identical.
export const DEFAULT_NO_CACHE_LABEL = "review:no-cache";

export function resolveNoCacheLabel(repo: ReviewQuillRepositoryConfig): string {
  return repo.noCacheLabel ?? DEFAULT_NO_CACHE_LABEL;
}

export interface ChangeIdentity {
  patchId: string;
  prBaseSha: string;
  diffBaseSha: string;
}

export interface PreparedReviewChange {
  identity: ChangeIdentity;
  workspace: ReviewWorkspace;
  dispose: () => Promise<void>;
}

export type CarryForwardResult =
  | { kind: "carried_forward"; attempt: ReviewAttemptRecord }
  | { kind: "no_candidate"; prepared: PreparedReviewChange }
  | { kind: "input_changed"; currentPr: PullRequestSummary }
  | { kind: "skipped"; reason: "no_cache_label" | "identity_unavailable" };

interface CarryForwardDeps {
  store: SqliteStore;
  github: GitHubClient;
  logger: Logger;
}

export async function revalidateCarryForwardInput(
  github: GitHubClient,
  repoFullName: string,
  pr: PullRequestSummary,
): Promise<{ currentPr: PullRequestSummary; valid: boolean }> {
  const currentPr = await github.getPullRequest(repoFullName, pr.number);
  return {
    currentPr,
    valid: classifyPublicationDisposition(currentPr, pr).action === "publish",
  };
}

export async function computeChangeIdentity(
  repo: ReviewQuillRepositoryConfig,
  pr: PullRequestSummary,
  github: GitHubClient,
  logger: Logger,
): Promise<PreparedReviewChange | undefined> {
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
    const patchId = await gitPatchId(materialized.workspace.worktreePath, materialized.workspace.baseRef, pr.headSha);
    if (!patchId) {
      // Empty diff — the PR has no change content. No identity to cache.
      await materialized.dispose();
      return undefined;
    }
    const identity: ChangeIdentity = {
      patchId,
      prBaseSha: pr.baseSha,
      diffBaseSha: materialized.workspace.baseRef,
    };
    return { identity, workspace: materialized.workspace, dispose: materialized.dispose };
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

export function lookupCarryForwardCandidate(
  repo: ReviewQuillRepositoryConfig,
  prNumber: number,
  identity: ChangeIdentity,
  store: SqliteStore,
  promptFingerprint?: string,
): ReviewAttemptRecord | undefined {
  return store.findApprovedAttemptByPatchId(
    repo.repoFullName,
    prNumber,
    identity.patchId,
    identity.diffBaseSha,
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
  }, "Carry-forward cache hit; re-emitting prior verdict on new head");

  const sameHead = candidate.headSha === pr.headSha;
  if (!sameHead) {
    // GitHub anchors review state to the SHA, so a new head needs its own
    // review row even when body/event are byte-identical.
    await deps.github.submitReview(repo.repoFullName, pr.number, {
      event: candidate.reviewEvent,
      body: candidate.reviewBody,
      commitId: pr.headSha,
    });
  }

  const attemptFields = {
    status: "completed" as const,
    conclusion: "approved" as const,
    promptFingerprint: buildPromptFingerprint(pr),
    patchId: identity.patchId,
    prBaseSha: identity.prBaseSha,
    diffBaseSha: identity.diffBaseSha,
    reviewBody: candidate.reviewBody,
    reviewEvent: candidate.reviewEvent,
    publicationMode: candidate.publicationMode ?? "body_only" as const,
    summary: `Carry-forward of attempt #${candidate.id} (same patch-id ${identity.patchId.slice(0, 12)}…)`,
    completedAt: new Date().toISOString(),
  };

  if (sameHead) {
    return deps.store.updateAttempt(candidate.id, attemptFields) ?? candidate;
  }

  return deps.store.createAttempt({
    repoFullName: repo.repoFullName,
    prNumber: pr.number,
    headSha: pr.headSha,
    ...(pr.title ? { prTitle: pr.title } : {}),
    priorAttemptId: candidate.id,
    ...attemptFields,
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

  const { identity } = computed;
  const candidate = lookupCarryForwardCandidate(repo, pr.number, identity, deps.store, buildPromptFingerprint(pr));
  if (!candidate || !candidate.reviewBody || !candidate.reviewEvent) {
    return { kind: "no_candidate", prepared: computed };
  }
  try {
    const revalidation = await revalidateCarryForwardInput(
      deps.github,
      repo.repoFullName,
      pr,
    );
    if (!revalidation.valid) {
      deps.logger.info({
        repo: repo.repoFullName,
        prNumber: pr.number,
        reviewedHeadSha: pr.headSha,
        reviewedBaseSha: pr.baseSha,
        currentHeadSha: revalidation.currentPr.headSha,
        currentBaseSha: revalidation.currentPr.baseSha,
      }, "Skipping stale carry-forward publication");
      return { kind: "input_changed", currentPr: revalidation.currentPr };
    }
    const inserted = await republishCarryForward(repo, pr, candidate, identity, deps);
    return { kind: "carried_forward", attempt: inserted };
  } finally {
    await computed.dispose();
  }
}
