import { buildFailedSessionPlan } from "./agent-session-plan.ts";
import {
  resolveActiveLinearState,
  resolveFallbackLinearState,
  resolveWorkflowLabelCleanup,
} from "./linear-workflow.ts";
import type { LinearClientProvider, ProjectConfig, StageRunRecord, TrackedIssueRecord } from "./types.ts";

function normalizeStateName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

interface FailureStores {
  upsertTrackedIssue?(params: Record<string, unknown>): void;
  setIssueStatusComment?(projectId: string, linearIssueId: string, commentId: string): void;
  // Accept anything that has these methods
  [key: string]: unknown;
}

export async function syncFailedStageToLinear(params: {
  stores: FailureStores;
  linearProvider: LinearClientProvider;
  project: ProjectConfig;
  issue: TrackedIssueRecord;
  stageRun: StageRunRecord;
  message: string;
  mode?: "launch" | "failed";
  requireActiveLinearStateMatch?: boolean;
}): Promise<void> {
  const linear = await params.linearProvider.forProject(params.stageRun.projectId);
  if (!linear) return;

  const fallbackState = resolveFallbackLinearState(params.project, params.stageRun.stage, params.issue.selectedWorkflowId);
  let shouldWriteFailureState = true;
  if (params.requireActiveLinearStateMatch) {
    const activeState = resolveActiveLinearState(params.project, params.stageRun.stage, params.issue.selectedWorkflowId);
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
      .updateIssueLabels({ issueId: params.stageRun.linearIssueId, removeNames: cleanup.remove })
      .catch(() => undefined);
  }

  if (!shouldWriteFailureState) return;

  if (fallbackState) {
    await linear.setIssueState(params.stageRun.linearIssueId, fallbackState).catch(() => undefined);
    params.stores.upsertTrackedIssue?.({
      projectId: params.stageRun.projectId,
      linearIssueId: params.stageRun.linearIssueId,
      currentLinearState: fallbackState,
      lifecycleStatus: "failed",
    });
  }

  if (params.issue.activeAgentSessionId) {
    await linear
      .updateAgentSession?.({
        agentSessionId: params.issue.activeAgentSessionId,
        plan: buildFailedSessionPlan(params.stageRun.stage, params.stageRun),
      })
      .catch(() => undefined);
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
