import {
  buildStageFailedComment,
  resolveActiveLinearState,
  resolveFallbackLinearState,
  resolveWorkflowLabelCleanup,
} from "./linear-workflow.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { LinearClientProvider, ProjectConfig, StageRunRecord, TrackedIssueRecord } from "./types.ts";

function normalizeStateName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export async function syncFailedStageToLinear(params: {
  db: PatchRelayDatabase;
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
    params.db.setIssueLifecycleStatus(params.stageRun.projectId, params.stageRun.linearIssueId, "failed");
    params.db.upsertTrackedIssue({
      projectId: params.stageRun.projectId,
      linearIssueId: params.stageRun.linearIssueId,
      currentLinearState: fallbackState,
      statusCommentId: params.issue.statusCommentId ?? null,
      lifecycleStatus: "failed",
    });
  }

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
    params.db.setIssueStatusComment(params.stageRun.projectId, params.stageRun.linearIssueId, result.id);
  }

  if (params.issue.activeAgentSessionId) {
    await linear
      .createAgentActivity({
        agentSessionId: params.issue.activeAgentSessionId,
        content: {
          type: "error",
          body: `PatchRelay could not complete the ${params.stageRun.stage} workflow: ${params.message}`,
        },
      })
      .catch(() => undefined);
  }
}
