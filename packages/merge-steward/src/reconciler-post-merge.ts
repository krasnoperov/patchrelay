import type { CheckResult, PostMergeStatus, QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";
import { evaluateCheckPolicy, formatRequiredCheck } from "./check-policy.ts";

export interface PostMergeVerificationResult {
  postMergeStatus: PostMergeStatus;
  postMergeSummary: string;
  postMergeSha: string;
}

function joinItems(items: string[]): string {
  if (items.length === 0) {
    return "";
  }
  return items.slice(0, 5).join(", ");
}

function evaluateChecks(
  requiredChecks: ReturnType<ReconcileContext["policy"]["getRequiredCheckRules"]>,
  requireAllChecksOnEmptyRequiredSet: boolean,
  checks: CheckResult[],
): { postMergeStatus: PostMergeStatus; summary: string } {
  const evaluation = evaluateCheckPolicy(requiredChecks, requireAllChecksOnEmptyRequiredSet, checks);
  if (evaluation.status === "fail") {
    const failed = evaluation.failing.map((check) => check.name);
    return {
      postMergeStatus: "fail",
      summary: failed.length === 1 ? `check failed: ${failed[0]}` : `checks failed: ${joinItems(failed)}`,
    };
  }
  if (evaluation.status === "pending") {
    if (checks.length === 0 && requiredChecks.length === 0 && !requireAllChecksOnEmptyRequiredSet) {
      return { postMergeStatus: "unknown", summary: "no checks found yet" };
    }
    const pending = [
      ...evaluation.missing.map(formatRequiredCheck),
      ...evaluation.pending.map((check) => check.name),
    ];
    return {
      postMergeStatus: "pending",
      summary: pending.length === 0
        ? "checks required but none found yet"
        : pending.length === 1
          ? `check pending: ${pending[0]}`
          : `checks pending: ${joinItems(pending)}`,
    };
  }
  return {
    postMergeStatus: "pass",
    summary: requiredChecks.length > 0
      ? "all required checks passed"
      : requireAllChecksOnEmptyRequiredSet
        ? "all observed checks passed"
        : "all checks passed",
  };
}

export async function verifyPostMergeStatus(
  ctx: ReconcileContext,
  entry: QueueEntry,
): Promise<PostMergeVerificationResult> {
  const postMergeSha = entry.postMergeSha ?? entry.candidateSha ?? entry.headSha;
  const requiredChecks = ctx.policy.getRequiredCheckRules();
  const requireAllChecksOnEmptyRequiredSet = ctx.policy.shouldRequireAllChecksOnEmptyRequiredSet();

  if (!postMergeSha) {
    return {
      postMergeStatus: "unknown",
      postMergeSummary: "post-merge SHA is unknown",
      postMergeSha: entry.headSha,
    };
  }

  let checks: CheckResult[];
  try {
    checks = await ctx.github.listChecksForRef(postMergeSha);
  } catch {
    checks = [];
  }
  const evaluation = evaluateChecks(requiredChecks, requireAllChecksOnEmptyRequiredSet, checks);
  return {
    postMergeStatus: evaluation.postMergeStatus,
    postMergeSummary: evaluation.summary,
    postMergeSha,
  };
}
