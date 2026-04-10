import type { ProjectConfig } from "./workflow-types.ts";

export const DEFAULT_CI_REPAIR_BUDGET = 3;
export const DEFAULT_QUEUE_REPAIR_BUDGET = 3;
export const DEFAULT_REVIEW_FIX_BUDGET = 3;

export function getCiRepairBudget(project: ProjectConfig | undefined): number {
  return project?.repairBudgets.ciRepair ?? DEFAULT_CI_REPAIR_BUDGET;
}

export function getQueueRepairBudget(project: ProjectConfig | undefined): number {
  return project?.repairBudgets.queueRepair ?? DEFAULT_QUEUE_REPAIR_BUDGET;
}

export function getReviewFixBudget(project: ProjectConfig | undefined): number {
  return project?.repairBudgets.reviewFix ?? DEFAULT_REVIEW_FIX_BUDGET;
}
