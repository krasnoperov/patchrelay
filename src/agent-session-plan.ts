import type { RunRecord } from "./db-types.ts";

export type AgentSessionPlanStatus = "pending" | "inProgress" | "completed" | "canceled";

export interface AgentSessionPlanStep {
  content: string;
  status: AgentSessionPlanStatus;
}

function formatRunLabel(runType: string): string {
  return runType.replace(/[-_]+/g, " ");
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function buildPlan(runType: string, statuses: [AgentSessionPlanStatus, AgentSessionPlanStatus, AgentSessionPlanStatus]) {
  const label = titleCase(formatRunLabel(runType));
  return [
    { content: "Prepare workspace", status: statuses[0] },
    { content: `Run ${label}`, status: statuses[1] },
    { content: "Review outcome", status: statuses[2] },
  ] satisfies AgentSessionPlanStep[];
}

export function buildPreparingSessionPlan(runType: string): AgentSessionPlanStep[] {
  return buildPlan(runType, ["inProgress", "pending", "pending"]);
}

export function buildRunningSessionPlan(runType: string): AgentSessionPlanStep[] {
  return buildPlan(runType, ["completed", "inProgress", "pending"]);
}

export function buildCompletedSessionPlan(runType: string): AgentSessionPlanStep[] {
  return buildPlan(runType, ["completed", "completed", "completed"]);
}

export function buildAwaitingHandoffSessionPlan(runType: string): AgentSessionPlanStep[] {
  return buildPlan(runType, ["completed", "completed", "inProgress"]);
}

export function buildFailedSessionPlan(runType: string, run?: Pick<RunRecord, "threadId" | "turnId">): AgentSessionPlanStep[] {
  const workflowStepStatus: AgentSessionPlanStatus = run?.threadId || run?.turnId ? "completed" : "inProgress";
  return buildPlan(runType, ["completed", workflowStepStatus, "pending"]);
}
