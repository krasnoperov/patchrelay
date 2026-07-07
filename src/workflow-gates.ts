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

export function evaluateTaskCompletion(snapshot: WorkflowSnapshot, task: WorkflowTask): GateDecision {
  if (!snapshot.authority.delegated) {
    return { action: "wait", reason: "authority_revoked" };
  }
  const pr = snapshot.artifacts.find((artifact) => artifact.type === "pr");
  if (task.runType === "implementation" && (!pr || pr.state !== "open")) {
    return { action: "escalate", reason: "implementation_completed_without_open_pr" };
  }
  if (task.runType === "branch_upkeep" && (!pr || (pr.state !== undefined && pr.state !== "open"))) {
    return { action: "escalate", reason: "branch_upkeep_completed_without_open_pr" };
  }
  if (task.runType === "review_fix") {
    const blockingHeadSha = task.requirements?.blockingHeadSha;
    const currentHeadSha = pr?.metadata?.headSha;
    if (typeof blockingHeadSha !== "string") {
      return { action: "ask", reason: "missing_blocking_review_head", question: "PatchRelay cannot verify the requested-changes repair without the original head SHA." };
    }
    if (currentHeadSha === blockingHeadSha) {
      return { action: "escalate", reason: "same_head_review_handoff_blocked" };
    }
  }
  if (task.runType === "ci_repair" || task.runType === "queue_repair") {
    const failureHeadSha = task.requirements?.failureHeadSha;
    const currentHeadSha = pr?.metadata?.headSha;
    if (typeof failureHeadSha !== "string") {
      return {
        action: "ask",
        reason: "missing_failure_head",
        question: "PatchRelay cannot verify the repair without the failing PR head SHA.",
      };
    }
    if (typeof currentHeadSha !== "string") {
      return { action: "escalate", reason: "repair_completed_without_pr_head" };
    }
  }
  return { action: "start" };
}
