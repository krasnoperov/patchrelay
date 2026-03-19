import type { CodexThreadSummary, CodexTurnSummary } from "./codex-types.ts";
import type { ReconciliationAction } from "./reconciliation-actions.ts";
import type {
  ReconciliationDecision,
  ReconciliationInput,
  ReconciliationIssueControl,
  ReconciliationLiveCodexState,
  ReconciliationLiveLinearState,
  ReconciliationObligation,
  ReconciliationPolicy,
  ReconciliationRun,
} from "./reconciliation-types.ts";

export class ReconciliationEngine {
  reconcile(input: ReconciliationInput): ReconciliationDecision {
    const actions: ReconciliationAction[] = [];
    const issue = input.issue;
    const policy = input.policy ?? {};
    const liveLinear = input.live?.linear ?? { status: "unknown" as const };
    const liveCodex = input.live?.codex ?? { status: "unknown" as const };
    const obligations = relevantObligations(issue, input.obligations ?? []);

    if (!issue.activeRun) {
      if (!issue.desiredStage) {
        return {
          outcome: "noop",
          reasons: ["issue has no active run and no desired stage"],
          actions,
        };
      }

      return {
        outcome: "launch",
        reasons: [`desired stage ${issue.desiredStage} is ready to launch`],
        actions: [
          {
            type: "launch_desired_stage",
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            stage: issue.desiredStage,
            reason: "desired stage exists without an active run",
          },
        ],
      };
    }

    if (needsLinearState(issue, policy, liveLinear)) {
      actions.push({
        type: "read_linear_issue",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        reason: "active reconciliation needs the live Linear state",
      });
    }

    if (needsCodexState(issue.activeRun, liveCodex)) {
      actions.push({
        type: "read_codex_thread",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        runId: issue.activeRun.id,
        threadId: issue.activeRun.threadId!,
        reason: "active reconciliation needs the live Codex thread",
      });
    }

    if (actions.length > 0) {
      return {
        outcome: "hydrate_live_state",
        reasons: ["reconciliation needs fresh live state before deciding"],
        actions,
      };
    }

    return reconcileActiveRun({
      issue,
      liveLinear,
      liveCodex,
      obligations,
      policy,
    });
  }
}

export function reconcileIssue(input: ReconciliationInput): ReconciliationDecision {
  return new ReconciliationEngine().reconcile(input);
}

function reconcileActiveRun(params: {
  issue: ReconciliationIssueControl;
  liveLinear: ReconciliationLiveLinearState;
  liveCodex: ReconciliationLiveCodexState;
  obligations: ReconciliationObligation[];
  policy: ReconciliationPolicy;
}): ReconciliationDecision {
  const { issue, liveLinear, liveCodex, obligations, policy } = params;
  const run = issue.activeRun!;
  const authoritativeStopState = resolveAuthoritativeStopState(liveLinear);

  if (authoritativeStopState) {
    return {
      outcome: "release",
      reasons: [`live Linear state is already ${authoritativeStopState.stateName}`],
      actions: [
        {
          type: "release_issue_ownership",
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          runId: run.id,
          nextLifecycleStatus: authoritativeStopState.lifecycleStatus,
          reason: `live Linear state is already ${authoritativeStopState.stateName}`,
        },
      ],
    };
  }

  if (run.status === "queued") {
    return {
      outcome: "launch",
      reasons: ["queued run has not been materialized yet"],
      actions: [
        {
          type: "launch_desired_stage",
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          stage: run.stage,
          runId: run.id,
          reason: "active run is queued and should be launched",
        },
      ],
    };
  }

  if (!run.threadId) {
    return failRun(issue, run, liveLinear, policy, "active run is missing a persisted thread id");
  }

  if (liveCodex.status === "error") {
    return {
      outcome: "continue",
      reasons: [liveCodex.errorMessage ?? "codex thread lookup failed"],
      actions: [
        {
          type: "await_codex_retry",
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          runId: run.id,
          reason: liveCodex.errorMessage ?? "codex thread lookup failed",
        },
      ],
    };
  }

  if (liveCodex.status === "missing" || !liveCodex.thread) {
    return failRun(issue, run, liveLinear, policy, "thread was not found during reconciliation");
  }

  const latestTurn = latestThreadTurn(liveCodex.thread);
  const targetTurnId = latestTurn?.id ?? run.turnId;

  if (!latestTurn || latestTurn.status === "inProgress") {
    const actions = routePendingObligations(issue, run, obligations, liveCodex.thread.id, targetTurnId);
    actions.push({
      type: "keep_run_active",
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runId: run.id,
      reason: !latestTurn ? "thread has not produced a turn yet" : "latest turn is still in progress",
    });
    return {
      outcome: "continue",
      reasons: [!latestTurn ? "thread has no completed turns yet" : "latest turn is still in progress"],
      actions,
    };
  }

  if (latestTurn.status !== "completed") {
    return failRun(issue, run, liveLinear, policy, "thread completed reconciliation in a failed state", latestTurn.id);
  }

  const actions: ReconciliationAction[] = [
    {
      type: "mark_run_completed",
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runId: run.id,
      threadId: liveCodex.thread.id,
      ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
      reason: "latest turn completed successfully during reconciliation",
    },
  ];

  if (shouldAwaitHandoff(liveLinear, policy)) {
    actions.push(
      {
        type: "clear_active_run",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        runId: run.id,
        nextLifecycleStatus: "paused",
        reason: "stage completed while the issue still matches the service-owned active Linear state",
      },
      {
        type: "refresh_status_comment",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        runId: run.id,
        ...(issue.statusCommentId ? { commentId: issue.statusCommentId } : {}),
        mode: "awaiting_handoff",
        reason: "stage completed and should publish an awaiting handoff status",
      },
    );
    return {
      outcome: "complete",
      reasons: ["stage completed and should pause for human handoff"],
      actions,
    };
  }

  actions.push({
    type: "release_issue_ownership",
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    runId: run.id,
    nextLifecycleStatus: "completed",
    reason: "stage completed after the live Linear state moved on",
  });

  return {
    outcome: "release",
    reasons: ["stage completed and the live Linear state already moved on"],
    actions,
  };
}

function failRun(
  issue: ReconciliationIssueControl,
  run: ReconciliationRun,
  liveLinear: ReconciliationLiveLinearState,
  policy: ReconciliationPolicy,
  message: string,
  turnId?: string,
): ReconciliationDecision {
  const actions: ReconciliationAction[] = [
    {
      type: "mark_run_failed",
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runId: run.id,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      ...(turnId ? { turnId } : run.turnId ? { turnId: run.turnId } : {}),
      reason: message,
    },
  ];

  if (shouldFailBack(liveLinear, policy)) {
    actions.push(
      {
        type: "sync_linear_failure",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        runId: run.id,
        ...(policy.activeLinearStateName ? { expectedStateName: policy.activeLinearStateName } : {}),
        ...(policy.fallbackLinearStateName ? { fallbackStateName: policy.fallbackLinearStateName } : {}),
        message,
      },
      {
        type: "clear_active_run",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        runId: run.id,
        nextLifecycleStatus: "failed",
        reason: "run failed while PatchRelay still owned the expected active Linear state",
      },
    );

    if (issue.statusCommentId) {
      actions.push({
        type: "refresh_status_comment",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        runId: run.id,
        commentId: issue.statusCommentId,
        mode: "failed",
        reason: "run failed and should refresh the service-owned status comment",
      });
    }

    return {
      outcome: "fail",
      reasons: [message],
      actions,
    };
  }

  actions.push({
    type: "release_issue_ownership",
    projectId: issue.projectId,
    linearIssueId: issue.linearIssueId,
    runId: run.id,
    nextLifecycleStatus: "failed",
    reason: "run failed after the live Linear state moved on",
  });

  return {
    outcome: "release",
    reasons: [message, "live Linear state no longer matches the expected service-owned active state"],
    actions,
  };
}

function routePendingObligations(
  issue: ReconciliationIssueControl,
  run: ReconciliationRun,
  obligations: ReconciliationObligation[],
  threadId: string,
  turnId?: string,
): ReconciliationAction[] {
  if (!turnId) {
    return [];
  }

  const actions: ReconciliationAction[] = [];
  for (const obligation of obligations) {
    const needsRouting = obligation.threadId !== threadId || obligation.turnId !== turnId;
    if (needsRouting) {
      actions.push({
        type: "route_obligation",
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        obligationId: obligation.id,
        runId: run.id,
        threadId,
        turnId,
        reason: "pending obligation should target the latest live turn",
      });
    }

    actions.push({
      type: "deliver_obligation",
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      obligationId: obligation.id,
      runId: run.id,
      threadId,
      turnId,
      reason: "pending obligation can be delivered to the active turn",
    });
  }
  return actions;
}

function needsLinearState(
  issue: ReconciliationIssueControl,
  policy: ReconciliationPolicy,
  liveLinear: ReconciliationLiveLinearState,
): boolean {
  if (!issue.activeRun) {
    return false;
  }
  if (!policy.activeLinearStateName && !policy.fallbackLinearStateName) {
    return false;
  }
  return liveLinear.status === "unknown";
}

function needsCodexState(run: ReconciliationRun, liveCodex: ReconciliationLiveCodexState): boolean {
  if (!run.threadId) {
    return false;
  }
  return liveCodex.status === "unknown";
}

function shouldFailBack(liveLinear: ReconciliationLiveLinearState, policy: ReconciliationPolicy): boolean {
  return matchesActiveLinearOwnership(liveLinear, policy);
}

function shouldAwaitHandoff(liveLinear: ReconciliationLiveLinearState, policy: ReconciliationPolicy): boolean {
  return matchesActiveLinearOwnership(liveLinear, policy);
}

function matchesActiveLinearOwnership(liveLinear: ReconciliationLiveLinearState, policy: ReconciliationPolicy): boolean {
  if (!policy.activeLinearStateName) {
    return true;
  }
  if (liveLinear.status !== "known") {
    return false;
  }
  return liveLinear.issue?.stateName === policy.activeLinearStateName;
}

function resolveAuthoritativeStopState(
  liveLinear: ReconciliationLiveLinearState,
): { stateName: string; lifecycleStatus: "completed" | "paused" } | undefined {
  if (liveLinear.status !== "known" || !liveLinear.issue?.stateName) {
    return undefined;
  }

  const stateName = liveLinear.issue.stateName.trim();
  const normalizedName = stateName.toLowerCase();
  const normalizedType = liveLinear.issue.stateType?.trim().toLowerCase();

  if (normalizedType === "completed" || normalizedName === "done" || normalizedName === "completed" || normalizedName === "complete") {
    return {
      stateName,
      lifecycleStatus: "completed",
    };
  }

  if (normalizedName === "human needed") {
    return {
      stateName,
      lifecycleStatus: "paused",
    };
  }

  return undefined;
}

function relevantObligations(
  issue: ReconciliationIssueControl,
  obligations: ReconciliationObligation[],
): ReconciliationObligation[] {
  const activeRunId = issue.activeRun?.id;
  return obligations.filter((obligation) => {
    if (obligation.status === "completed" || obligation.status === "cancelled") {
      return false;
    }
    if (activeRunId === undefined) {
      return false;
    }
    return obligation.runId === undefined || obligation.runId === activeRunId;
  });
}

function latestThreadTurn(thread: CodexThreadSummary): CodexTurnSummary | undefined {
  return thread.turns.at(-1);
}
