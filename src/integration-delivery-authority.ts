import type { WorkflowSnapshot, WorkflowTask } from "./workflow-model.ts";

/**
 * An approved, green PR grants authority only for the repository-owned
 * integration candidate. It never grants authority to edit the feature
 * branch or resume general implementation work.
 */
export function hasIntegrationDeliveryAuthority(
  snapshot: Omit<WorkflowSnapshot, "openTasks">,
): boolean {
  const pr = snapshot.artifacts.find((artifact) => artifact.type === "pr");
  const context = snapshot.context.failureContext;
  if (!pr || pr.state !== "open" || pr.metadata?.isDraft === true) return false;
  if (pr.metadata?.reviewState !== "approved" || pr.metadata?.checkStatus !== "success") return false;
  if (snapshot.context.lastGitHubFailureSource !== "queue_eviction") return false;
  if (context?.integrationFailureKind !== "conflict" && context?.integrationFailureKind !== "candidate_ci") return false;
  if (typeof context.candidateBranch !== "string" || typeof context.approvedHeadSha !== "string") return false;
  if (pr.metadata?.headSha !== context.approvedHeadSha) return false;
  return context.candidateBranch.endsWith(`/pr-${pr.ref}`);
}

export function taskUsesIntegrationDeliveryAuthority(
  snapshot: WorkflowSnapshot,
  task: WorkflowTask,
): boolean {
  return task.type === "run"
    && runUsesIntegrationDeliveryAuthority(snapshot, task.runType);
}

export function runUsesIntegrationDeliveryAuthority(
  snapshot: Omit<WorkflowSnapshot, "openTasks">,
  runType: string | undefined,
): boolean {
  return runType === "integration_repair" && hasIntegrationDeliveryAuthority(snapshot);
}
