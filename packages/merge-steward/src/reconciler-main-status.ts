import type { CIStatus } from "./types.ts";
import type { ReconcileContext } from "./reconciler-core.ts";

export interface EffectiveMainStatus {
  status: CIStatus;
  trustedMergedEntryId?: string | undefined;
  trustedMergedPrNumber?: number | undefined;
}

export async function getEffectiveMainStatus(
  ctx: ReconcileContext,
  baseSha: string,
): Promise<EffectiveMainStatus> {
  const status = await ctx.ci.getMainStatus?.(ctx.baseBranch) ?? "pass";
  if (status !== "pending") {
    return { status };
  }

  const trustedMergedEntry = ctx.store.listAll(ctx.repoId).find((entry) =>
    entry.status === "merged"
    && entry.postMergeStatus === "pass"
    && entry.postMergeSha === baseSha
  );
  if (!trustedMergedEntry) {
    return { status };
  }

  return {
    status: "pass",
    trustedMergedEntryId: trustedMergedEntry.id,
    trustedMergedPrNumber: trustedMergedEntry.prNumber,
  };
}
