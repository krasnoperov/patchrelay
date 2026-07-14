import type { GateDecision, WorkflowSnapshot, WorkflowTask } from "./workflow-model.ts";

export function evaluateTaskStart(snapshot: WorkflowSnapshot, task: WorkflowTask): GateDecision {
  if (!snapshot.authority.delegated) {
    return { action: "wait", reason: "authority_not_delegated" };
  }
  if (snapshot.activeRun) {
    return { action: "wait", reason: "active_run_present" };
  }
  if (task.type !== "run") {
    return { action: "start" };
  }
  if (task.runType === "implementation" && snapshot.blockerCount > 0) {
    return { action: "wait", reason: "blocked" };
  }
  if (task.runType === "branch_upkeep") {
    const pr = snapshot.artifacts.find((artifact) => artifact.type === "pr");
    if (!pr || (pr.state !== undefined && pr.state !== "open")) {
      return { action: "wait", reason: "missing_open_pr" };
    }
    return { action: "start" };
  }
  if (task.runType === "review_fix" && typeof task.requirements?.blockingHeadSha !== "string") {
    return {
      action: "ask",
      reason: "missing_blocking_review_head",
      question: "PatchRelay cannot verify the requested-changes repair without a blocking review head SHA.",
    };
  }
  if (task.runType === "ci_repair" && typeof task.requirements?.failureHeadSha !== "string") {
    return { action: "wait", reason: "missing_failure_head" };
  }
  return { action: "start" };
}
