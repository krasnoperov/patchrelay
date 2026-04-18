import type { CheckResult, PostMergeStatus, QueueEntry } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";

export interface PostMergeVerificationResult {
  postMergeStatus: PostMergeStatus;
  postMergeSummary: string;
  postMergeSha: string;
}

function normalizeCheckName(name: string): string {
  return name.trim().toLowerCase();
}

function joinItems(items: string[]): string {
  if (items.length === 0) {
    return "";
  }
  return items.slice(0, 5).join(", ");
}

function evaluateChecks(
  requiredChecks: string[],
  requireAllChecksOnEmptyRequiredSet: boolean,
  checks: CheckResult[],
): { postMergeStatus: PostMergeStatus; summary: string } {
  const isPassingConclusion = (conclusion: CheckResult["conclusion"]) => conclusion === "success";
  if (requiredChecks.length > 0) {
    const byName = new Map(checks.map((check) => [normalizeCheckName(check.name), check]));
    const failed: string[] = [];
    const pending: string[] = [];
    for (const required of requiredChecks) {
      const check = byName.get(normalizeCheckName(required));
      if (!check) {
        pending.push(required);
        continue;
      }
      if (check.conclusion === "pending") {
        pending.push(check.name);
      } else if (!isPassingConclusion(check.conclusion)) {
        failed.push(check.name);
      }
    }

    if (failed.length > 0) {
      return {
        postMergeStatus: "fail",
        summary: failed.length === 1 ? `check failed: ${failed[0]}` : `checks failed: ${joinItems(failed)}`,
      };
    }
    if (pending.length > 0) {
      return {
        postMergeStatus: "pending",
        summary: pending.length === 1 ? `check pending: ${pending[0]}` : `checks pending: ${joinItems(pending)}`,
      };
    }
    return { postMergeStatus: "pass", summary: "all required checks passed" };
  }

  const pending = checks.filter((check) => check.conclusion === "pending").map((check) => check.name);
  const failed = checks.filter((check) => !isPassingConclusion(check.conclusion)).map((check) => check.name);

  if (checks.length === 0) {
    return {
      postMergeStatus: requireAllChecksOnEmptyRequiredSet ? "pending" : "unknown",
      summary: requireAllChecksOnEmptyRequiredSet ? "checks required but none found yet" : "no checks found yet",
    };
  }
  if (failed.length > 0) {
    return {
      postMergeStatus: "fail",
      summary: failed.length === 1 ? `check failed: ${failed[0]}` : `checks failed: ${joinItems(failed)}`,
    };
  }
  if (pending.length > 0) {
    return {
      postMergeStatus: "pending",
      summary: pending.length === 1 ? `check pending: ${pending[0]}` : `checks pending: ${joinItems(pending)}`,
    };
  }
  return {
    postMergeStatus: "pass",
    summary: requireAllChecksOnEmptyRequiredSet ? "all observed checks passed" : "all checks passed",
  };
}

export async function verifyPostMergeStatus(
  ctx: ReconcileContext,
  entry: QueueEntry,
): Promise<PostMergeVerificationResult> {
  const postMergeSha = entry.postMergeSha ?? entry.specSha ?? entry.headSha;
  const requiredChecks = ctx.policy.getRequiredChecks();
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
