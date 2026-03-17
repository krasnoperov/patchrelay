import type { StageRunRecord, WorkflowStage } from "./types.ts";

export type AgentSessionPlanStatus = "pending" | "in_progress" | "completed";

export interface AgentSessionPlanStep {
  label: string;
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
    { label: "Prepare workspace", status: statuses[0] },
    { label: `Run ${stageLabel} workflow`, status: statuses[1] },
    { label: "Review next Linear step", status: statuses[2] },
  ] satisfies AgentSessionPlanStep[];
}

export function buildPreparingSessionPlan(stage: WorkflowStage): AgentSessionPlanStep[] {
  return buildPlan(stage, ["in_progress", "pending", "pending"]);
}

export function buildRunningSessionPlan(stage: WorkflowStage): AgentSessionPlanStep[] {
  return buildPlan(stage, ["completed", "in_progress", "pending"]);
}

export function buildCompletedSessionPlan(stage: WorkflowStage): AgentSessionPlanStep[] {
  return buildPlan(stage, ["completed", "completed", "completed"]);
}

export function buildAwaitingHandoffSessionPlan(stage: WorkflowStage): AgentSessionPlanStep[] {
  return buildPlan(stage, ["completed", "completed", "in_progress"]);
}

export function buildFailedSessionPlan(stage: WorkflowStage, stageRun?: Pick<StageRunRecord, "threadId" | "turnId">): AgentSessionPlanStep[] {
  const workflowStepStatus: AgentSessionPlanStatus = stageRun?.threadId || stageRun?.turnId ? "completed" : "in_progress";
  return buildPlan(stage, ["completed", workflowStepStatus, "pending"]);
}
