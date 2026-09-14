import type { IssueRecord } from "./db-types.ts";
import type { UpsertIssueParams } from "./db/issue-store.ts";
import { isRequestedChangesRunType } from "./reactive-pr-state.ts";
import type { RunContext } from "./run-context.ts";
import type { RunType } from "./run-type.ts";

export type AttemptAccountingFields = Partial<Pick<
  UpsertIssueParams,
  | "ciRepairAttempts"
  | "queueRepairAttempts"
  | "reviewFixAttempts"
  | "lastAttemptedFailureHeadSha"
  | "lastAttemptedFailureSignature"
  | "lastAttemptedFailureAt"
>>;

export function buildAttemptStartFields(
  runType: RunType,
  issue: Pick<IssueRecord, "ciRepairAttempts" | "queueRepairAttempts" | "reviewFixAttempts">,
  context?: RunContext,
): AttemptAccountingFields {
  const counter = runType === "ci_repair"
    ? { ciRepairAttempts: issue.ciRepairAttempts + 1 }
    : runType === "integration_repair" || runType === "queue_repair"
      ? { queueRepairAttempts: issue.queueRepairAttempts + 1 }
      : isRequestedChangesRunType(runType)
        ? { reviewFixAttempts: issue.reviewFixAttempts + 1 }
        : {};
  const failureSignature = context?.failureSignature;
  const provenance = (runType === "ci_repair" || runType === "integration_repair" || runType === "queue_repair")
    && failureSignature
    ? {
        lastAttemptedFailureSignature: failureSignature,
        lastAttemptedFailureHeadSha: context?.failureHeadSha ?? null,
        lastAttemptedFailureAt: new Date().toISOString(),
      }
    : {};
  return { ...counter, ...provenance };
}

export function buildAttemptRefundFields(
  runType: RunType,
  issue: Pick<IssueRecord, "ciRepairAttempts" | "queueRepairAttempts" | "reviewFixAttempts">,
): AttemptAccountingFields {
  const counter = runType === "ci_repair" && issue.ciRepairAttempts > 0
    ? { ciRepairAttempts: issue.ciRepairAttempts - 1 }
    : (runType === "integration_repair" || runType === "queue_repair") && issue.queueRepairAttempts > 0
      ? { queueRepairAttempts: issue.queueRepairAttempts - 1 }
      : isRequestedChangesRunType(runType) && issue.reviewFixAttempts > 0
        ? { reviewFixAttempts: issue.reviewFixAttempts - 1 }
        : {};
  const provenance = runType === "ci_repair" || runType === "integration_repair" || runType === "queue_repair"
    ? {
        lastAttemptedFailureHeadSha: null,
        lastAttemptedFailureSignature: null,
        lastAttemptedFailureAt: null,
      }
    : {};
  return { ...counter, ...provenance };
}
