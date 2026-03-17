import { buildFailedSessionPlan } from "./agent-session-plan.ts";
import {
  buildStageFailedComment,
  resolveActiveLinearState,
  resolveFallbackLinearState,
  resolveWorkflowLabelCleanup,
} from "./linear-workflow.ts";
import type { IssueWorkflowCoordinatorProvider } from "./workflow-ports.ts";
import type { LinearClientProvider, ProjectConfig, StageRunRecord, TrackedIssueRecord } from "./types.ts";

function normalizeStateName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export async function syncFailedStageToLinear(params: {
  stores: IssueWorkflowCoordinatorProvider;
  linearProvider: LinearClientProvider;
  project: ProjectConfig;
  issue: TrackedIssueRecord;
  stageRun: StageRunRecord;
  message: string;
  mode?: "launch" | "failed";
  requireActiveLinearStateMatch?: boolean;
}): Promise<void> {
  const linear = await params.linearProvider.forProject(params.stageRun.projectId);
  if (!linear) {
    return;
  }

  const fallbackState = resolveFallbackLinearState(params.project, params.stageRun.stage);
  let shouldWriteFailureState = true;
  if (params.requireActiveLinearStateMatch) {
    const activeState = resolveActiveLinearState(params.project, params.stageRun.stage);
    if (!activeState) {
      shouldWriteFailureState = false;
    } else {
      try {
        const linearIssue = await linear.getIssue(params.stageRun.linearIssueId);
        shouldWriteFailureState = normalizeStateName(linearIssue.stateName) === normalizeStateName(activeState);
      } catch {
        shouldWriteFailureState = false;
      }
    }
  }

  const cleanup = resolveWorkflowLabelCleanup(params.project);
  if (cleanup.remove.length > 0) {
    await linear
      .updateIssueLabels({
        issueId: params.stageRun.linearIssueId,
        removeNames: cleanup.remove,
      })
      .catch(() => undefined);
  }

  if (!shouldWriteFailureState) {
    return;
  }

  if (fallbackState) {
    await linear.setIssueState(params.stageRun.linearIssueId, fallbackState).catch(() => undefined);
    params.stores.workflowCoordinator.upsertTrackedIssue({
      projectId: params.stageRun.projectId,
      linearIssueId: params.stageRun.linearIssueId,
      currentLinearState: fallbackState,
      statusCommentId: params.issue.statusCommentId ?? null,
      activeAgentSessionId: params.issue.activeAgentSessionId ?? null,
      lifecycleStatus: "failed",
    });
  }

  let deliveredToSession = false;
  if (params.issue.activeAgentSessionId) {
    deliveredToSession =
      (await linear
        .updateAgentSession?.({
          agentSessionId: params.issue.activeAgentSessionId,
          plan: buildFailedSessionPlan(params.stageRun.stage, params.stageRun),
        })
        .then(() => true)
        .catch(() => false)) ?? false;
    deliveredToSession =
      (await linear
        .createAgentActivity({
          agentSessionId: params.issue.activeAgentSessionId,
          content: {
            type: "error",
            body: `PatchRelay could not complete the ${params.stageRun.stage} workflow: ${params.message}`,
          },
        })
        .then(() => true)
        .catch(() => false)) || deliveredToSession;
  }

  if (!deliveredToSession && !params.issue.activeAgentSessionId) {
    const result = await linear
      .upsertIssueComment({
        issueId: params.stageRun.linearIssueId,
        ...(params.issue.statusCommentId ? { commentId: params.issue.statusCommentId } : {}),
        body: buildStageFailedComment({
          issue: params.issue,
          stageRun: params.stageRun,
          message: params.message,
          ...(fallbackState ? { fallbackState } : {}),
          ...(params.mode ? { mode: params.mode } : {}),
        }),
      })
      .catch(() => undefined);
    if (result) {
      params.stores.workflowCoordinator.setIssueStatusComment(params.stageRun.projectId, params.stageRun.linearIssueId, result.id);
    }
  }
}
