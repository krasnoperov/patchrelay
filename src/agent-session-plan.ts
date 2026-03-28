import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";

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

export function formatRunTypeLabel(runType: string): string {
  return titleCase(formatRunLabel(runType));
}

function implementationPlan(): AgentSessionPlanStep[] {
  return [
    { content: "Prepare workspace", status: "pending" },
    { content: "Implementing", status: "pending" },
    { content: "Awaiting verification", status: "pending" },
    { content: "Merge", status: "pending" },
  ];
}

function reviewFixPlan(): AgentSessionPlanStep[] {
  return [
    { content: "Prepare workspace", status: "completed" },
    { content: "Addressing review feedback", status: "pending" },
    { content: "Awaiting re-verification", status: "pending" },
    { content: "Merge", status: "pending" },
  ];
}

function ciRepairPlan(attempt: number): AgentSessionPlanStep[] {
  return [
    { content: "Prepare workspace", status: "completed" },
    { content: "Implementing", status: "completed" },
    { content: `Repairing checks (${attemptLabel(attempt)})`, status: "pending" },
    { content: "Merge", status: "pending" },
  ];
}

function queueRepairPlan(attempt: number): AgentSessionPlanStep[] {
  return [
    { content: "Prepare workspace", status: "completed" },
    { content: "Implementing", status: "completed" },
    { content: "Verification passed", status: "completed" },
    { content: `Repairing merge (${attemptLabel(attempt)})`, status: "pending" },
  ];
}

function awaitingInputPlan(): AgentSessionPlanStep[] {
  return [
    { content: "Prepare workspace", status: "completed" },
    { content: "Implement or update branch", status: "completed" },
    { content: "Review approved", status: "completed" },
    { content: "Waiting for guidance", status: "inProgress" },
  ];
}

function failedPlan(label: string): AgentSessionPlanStep[] {
  return [
    { content: "Prepare workspace", status: "completed" },
    { content: "Implement or update branch", status: "completed" },
    { content: "Review approved", status: "completed" },
    { content: label, status: "inProgress" },
  ];
}

function attemptLabel(attempt: number): string {
  const safeAttempt = Math.max(1, attempt);
  return `attempt ${safeAttempt}`;
}

function setStatuses(
  plan: AgentSessionPlanStep[],
  statuses: [AgentSessionPlanStatus, AgentSessionPlanStatus, AgentSessionPlanStatus, AgentSessionPlanStatus],
): AgentSessionPlanStep[] {
  return plan.map((step, index) => ({ ...step, status: statuses[index] ?? step.status }));
}

function resolvePlanRunType(params: {
  factoryState: FactoryState;
  activeRunType?: RunType;
  pendingRunType?: RunType;
}): RunType {
  if (params.activeRunType) {
    return params.activeRunType;
  }
  if (params.pendingRunType) {
    return params.pendingRunType;
  }
  switch (params.factoryState) {
    case "changes_requested":
      return "review_fix";
    case "repairing_ci":
      return "ci_repair";
    case "repairing_queue":
      return "queue_repair";
    default:
      return "implementation";
  }
}

export function buildAgentSessionPlan(params: {
  factoryState: FactoryState;
  activeRunType?: RunType;
  pendingRunType?: RunType;
  ciRepairAttempts?: number;
  queueRepairAttempts?: number;
}): AgentSessionPlanStep[] {
  const runType = resolvePlanRunType(params);

  switch (params.factoryState) {
    case "delegated":
      return setStatuses(planForRunType(runType, params), ["inProgress", "pending", "pending", "pending"]);
    case "implementing":
      return setStatuses(planForRunType("implementation", params), ["completed", "inProgress", "pending", "pending"]);
    case "pr_open":
      return setStatuses(implementationPlan(), ["completed", "completed", "inProgress", "pending"]);
    case "changes_requested":
      return setStatuses(reviewFixPlan(), ["completed", "inProgress", "pending", "pending"]);
    case "repairing_ci":
      return setStatuses(ciRepairPlan(params.ciRepairAttempts ?? 1), ["completed", "completed", "inProgress", "pending"]);
    case "awaiting_queue":
      return setStatuses([
        { content: "Prepare workspace", status: "completed" },
        { content: "Implementing", status: "completed" },
        { content: "Verification passed", status: "completed" },
        { content: "Awaiting merge", status: "inProgress" },
      ], ["completed", "completed", "completed", "inProgress"]);
    case "repairing_queue":
      return setStatuses(queueRepairPlan(params.queueRepairAttempts ?? 1), ["completed", "completed", "completed", "inProgress"]);
    case "awaiting_input":
      return awaitingInputPlan();
    case "escalated":
      return failedPlan("Needs human help");
    case "failed":
      return failedPlan("Recovery needed");
    case "done":
      return setStatuses([
        { content: "Prepare workspace", status: "completed" },
        { content: "Implementing", status: "completed" },
        { content: "Verification passed", status: "completed" },
        { content: "Merged", status: "completed" },
      ], ["completed", "completed", "completed", "completed"]);
  }
}

function planForRunType(
  runType: RunType,
  params: {
    ciRepairAttempts?: number;
    queueRepairAttempts?: number;
  },
): AgentSessionPlanStep[] {
  switch (runType) {
    case "review_fix":
      return reviewFixPlan();
    case "ci_repair":
      return ciRepairPlan(params.ciRepairAttempts ?? 1);
    case "queue_repair":
      return queueRepairPlan(params.queueRepairAttempts ?? 1);
    case "implementation":
    default:
      return implementationPlan();
  }
}

export function buildAgentSessionPlanForIssue(
  issue: Pick<IssueRecord, "factoryState" | "pendingRunType" | "ciRepairAttempts" | "queueRepairAttempts">,
  options?: { activeRunType?: RunType },
): AgentSessionPlanStep[] {
  return buildAgentSessionPlan({
    factoryState: issue.factoryState,
    ciRepairAttempts: issue.ciRepairAttempts,
    queueRepairAttempts: issue.queueRepairAttempts,
    ...(issue.pendingRunType ? { pendingRunType: issue.pendingRunType } : {}),
    ...(options?.activeRunType ? { activeRunType: options.activeRunType } : {}),
  });
}

export function buildRunningSessionPlan(runType: string): AgentSessionPlanStep[] {
  return buildAgentSessionPlan({
    factoryState: runType === "ci_repair" ? "repairing_ci"
      : runType === "review_fix" ? "changes_requested"
      : runType === "queue_repair" ? "repairing_queue"
      : "implementing",
    activeRunType: runType as RunType,
  });
}

export function buildCompletedSessionPlan(runType: string): AgentSessionPlanStep[] {
  if (runType === "ci_repair" || runType === "queue_repair") {
    return buildAgentSessionPlan({ factoryState: "awaiting_queue" });
  }
  return buildAgentSessionPlan({ factoryState: "pr_open" });
}

export function buildAwaitingHandoffSessionPlan(runType: string): AgentSessionPlanStep[] {
  return buildCompletedSessionPlan(runType);
}

export function buildFailedSessionPlan(runType: string, run?: Pick<RunRecord, "threadId" | "turnId">): AgentSessionPlanStep[] {
  void run;
  return buildAgentSessionPlan({
    factoryState: "failed",
    activeRunType: runType as RunType,
  });
}
