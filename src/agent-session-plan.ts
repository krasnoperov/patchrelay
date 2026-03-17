import type { StageRunRecord, WorkflowStage } from "./types.ts";

export type AgentSessionPlanStatus = "pending" | "inProgress" | "completed" | "canceled";

export interface AgentSessionPlanStep {
  content: string;
  status: AgentSessionPlanStatus;
}

function formatStageLabel(stage: WorkflowStage): string {
  return stage.replace(/[-_]+/g, " ");
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function buildPlan(stage: WorkflowStage, statuses: [AgentSessionPlanStatus, AgentSessionPlanStatus, AgentSessionPlanStatus]) {
  const stageLabel = titleCase(formatStageLabel(stage));
  return [
    { content: "Prepare workspace", status: statuses[0] },
    { content: `Run ${stageLabel} workflow`, status: statuses[1] },
    { content: "Review next Linear step", status: statuses[2] },
  ] satisfies AgentSessionPlanStep[];
}

export function buildPreparingSessionPlan(stage: WorkflowStage): AgentSessionPlanStep[] {
  return buildPlan(stage, ["inProgress", "pending", "pending"]);
}

export function buildRunningSessionPlan(stage: WorkflowStage): AgentSessionPlanStep[] {
  return buildPlan(stage, ["completed", "inProgress", "pending"]);
}

export function buildCompletedSessionPlan(stage: WorkflowStage): AgentSessionPlanStep[] {
  return buildPlan(stage, ["completed", "completed", "completed"]);
}

export function buildAwaitingHandoffSessionPlan(stage: WorkflowStage): AgentSessionPlanStep[] {
  return buildPlan(stage, ["completed", "completed", "inProgress"]);
}

export function buildFailedSessionPlan(stage: WorkflowStage, stageRun?: Pick<StageRunRecord, "threadId" | "turnId">): AgentSessionPlanStep[] {
  const workflowStepStatus: AgentSessionPlanStatus = stageRun?.threadId || stageRun?.turnId ? "completed" : "inProgress";
  return buildPlan(stage, ["completed", workflowStepStatus, "pending"]);
}
