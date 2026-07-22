import { isCurrentHeadRequestedChanges } from "./reactive-workflow-intent.ts";
import type { WorkflowSnapshot, WorkflowTask } from "./workflow-model.ts";

export function deriveWorkflowTasks(snapshot: Omit<WorkflowSnapshot, "openTasks">): WorkflowTask[] {
  const tasks: WorkflowTask[] = [];
  if (!snapshot.authority.delegated) {
    return [{
      id: "wait:authority",
      type: "wait",
      reason: "Workflow is waiting for delegated authority",
    }];
  }
  if (snapshot.activeRun) {
    return [{
      id: `wait:active-run:${snapshot.activeRun.id}`,
      type: "wait",
      reason: "A run is already active",
    }];
  }
  const issue = snapshot.context;
  if (snapshot.status === "done") {
    if (issue.inputInboxContext) {
      tasks.push({
        id: "run:input",
        type: "run",
        runType: issue.inputInboxContext.runType,
        reason: "Unconsumed human input reopens completed workflow work",
        requirements: issue.inputInboxContext.requirements,
      });
    }
    return tasks;
  }
  if (snapshot.status === "failed") {
    return [];
  }
  const prArtifact = snapshot.artifacts.find((artifact) => artifact.type === "pr");
  const prState = prArtifact?.state;
  const prHeadSha = prArtifact?.metadata?.headSha;
  const prReviewState = prArtifact?.metadata?.reviewState;
  const prCheckStatus = prArtifact?.metadata?.checkStatus;
  const prIsDraft = prArtifact?.metadata?.isDraft === true;
  const hasPrArtifact = prArtifact !== undefined;
  const hasThread = snapshot.artifacts.some((artifact) => artifact.type === "codex_thread");
  const branchUpkeepSignalled = hasPrArtifact
    && !prIsDraft
    && (prState === undefined || prState === "open")
    && issue.branchUpkeepContext !== undefined;
  const queueRepairSignalled = !prIsDraft && prState === "open" && issue.lastGitHubFailureSource === "queue_eviction";
  const branchFailureMatchesCurrentHead = !prIsDraft
    && issue.lastGitHubFailureSource === "branch_ci"
    && typeof issue.lastGitHubFailureHeadSha === "string"
    && typeof prHeadSha === "string"
    && issue.lastGitHubFailureHeadSha === prHeadSha;
  const artifactCiFailureMatchesCurrentHead = !prIsDraft
    && (prCheckStatus === "failed" || prCheckStatus === "failure")
    && typeof prHeadSha === "string";
  const ciFailureMatchesCurrentHead = branchFailureMatchesCurrentHead || artifactCiFailureMatchesCurrentHead;
  const ciFailureHeadSha = issue.lastGitHubFailureHeadSha ?? (typeof prHeadSha === "string" ? prHeadSha : undefined);
  const ciFailureAlreadyAttempted = ciFailureMatchesCurrentHead
    && issue.lastAttemptedFailureHeadSha === ciFailureHeadSha
    && (
      typeof issue.lastGitHubFailureSignature !== "string"
      || issue.lastAttemptedFailureSignature === issue.lastGitHubFailureSignature
    );
  const ciRepairSignalled = prState === "open" && ciFailureMatchesCurrentHead && !ciFailureAlreadyAttempted;
  const structuralRepairSignalled = queueRepairSignalled || ciRepairSignalled || branchUpkeepSignalled;

  const inputInbox = issue.inputInboxContext;
  if (inputInbox && !structuralRepairSignalled) {
    tasks.push({
      id: "run:input",
      type: "run",
      runType: inputInbox.runType,
      reason: "Unconsumed human input / completion-check continuation needs a run",
      requirements: inputInbox.requirements,
    });
    return tasks;
  }

  const orchestrationInbox = issue.orchestrationInboxContext;
  if (orchestrationInbox && hasThread && !structuralRepairSignalled) {
    tasks.push({
      id: "run:orchestration_followup",
      type: "run",
      runType: "implementation",
      reason: "Child workflow updates need parent re-planning",
      requirements: orchestrationInbox.requirements,
    });
    return tasks;
  }

  if (issue.inputRequestKind && !structuralRepairSignalled) {
    return [{
      id: "wait:input",
      type: "wait",
      reason: "Workflow is waiting for human input",
    }];
  }

  if (snapshot.blockerCount > 0 && prState !== "open") {
    return [{
      id: "wait:blockers",
      type: "wait",
      reason: "Workflow is blocked by unresolved Linear dependencies",
      requirements: { blockerCount: snapshot.blockerCount },
    }];
  }

  if (snapshot.childCount > 0 && prState !== "open") {
    if (snapshot.openChildCount > 0) {
      return [{
        id: "wait:children",
        type: "wait",
        reason: "Workflow is waiting for child workflows to complete",
        requirements: {
          childCount: snapshot.childCount,
          openChildCount: snapshot.openChildCount,
        },
      }];
    }
    return [{
      id: "verify:children_complete",
      type: "verify",
      reason: "Child workflows are complete; parent objective needs verification",
      requirements: { childCount: snapshot.childCount },
    }];
  }

  const branchUpkeepTask = (): WorkflowTask => ({
    id: "run:branch_upkeep",
    type: "run",
    runType: "branch_upkeep",
    reason: "Parent PR head moved (or PR left dirty); branch needs upkeep onto latest",
    requirements: {
      branchUpkeepRequired: true,
      reviewFixMode: "branch_upkeep",
      workflowReason: "branch_upkeep",
      ...(issue.branchUpkeepContext?.parentBranch ? { baseBranch: issue.branchUpkeepContext.parentBranch } : {}),
      ...(issue.branchUpkeepContext?.parentHeadSha ? { parentHeadSha: issue.branchUpkeepContext.parentHeadSha } : {}),
      ...(issue.branchUpkeepContext?.childPrNumber !== undefined ? { childPrNumber: issue.branchUpkeepContext.childPrNumber } : {}),
      ...(prState ? { prState } : {}),
    },
  });

  if (branchUpkeepSignalled && !queueRepairSignalled && !ciRepairSignalled) {
    tasks.push(branchUpkeepTask());
    return tasks;
  }

  if (!branchUpkeepSignalled && !prIsDraft && prState === "open" && isCurrentHeadRequestedChanges({
    prReviewState: typeof prReviewState === "string" ? prReviewState : undefined,
    prHeadSha: typeof prHeadSha === "string" ? prHeadSha : undefined,
    lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha,
  })) {
    tasks.push({
      id: "run:review_fix",
      type: "run",
      runType: "review_fix",
      reason: "PR has requested changes",
      requirements: {
        ...issue.requestedChangesContext,
        prState,
        blockingHeadSha: issue.lastBlockingReviewHeadSha ?? prHeadSha,
        requestedChangesHeadSha: issue.requestedChangesContext?.requestedChangesHeadSha
          ?? issue.lastBlockingReviewHeadSha
          ?? prHeadSha,
      },
    });
    return tasks;
  }

  if (queueRepairSignalled) {
    tasks.push({
      id: "run:queue_repair",
      type: "run",
      runType: "queue_repair",
      reason: "Merge queue eviction requires repair",
      requirements: {
        ...issue.failureContext,
        failureSignature: issue.lastGitHubFailureSignature,
        failureHeadSha: issue.lastGitHubFailureHeadSha ?? prHeadSha,
      },
    });
    return tasks;
  }

  if (ciRepairSignalled) {
    tasks.push({
      id: "run:ci_repair",
      type: "run",
      runType: "ci_repair",
      reason: "Settled branch CI failure requires repair",
      requirements: {
        ...issue.failureContext,
        failureSignature: issue.lastGitHubFailureSignature,
        failureHeadSha: ciFailureHeadSha,
        ...(issue.ciSnapshot ? { ciSnapshot: issue.ciSnapshot } : {}),
      },
    });
    return tasks;
  }

  const hasUsablePrArtifact = hasPrArtifact && (prState === undefined || prState === "open");
  if (!hasUsablePrArtifact || prIsDraft) {
    tasks.push({
      id: "run:implementation",
      type: "run",
      runType: "implementation",
      reason: prIsDraft
        ? "Delegated workflow has only a draft PR; implementation continues"
        : hasPrArtifact
          ? "Delegated workflow has no usable open PR artifact"
          : "Delegated workflow has no PR artifact yet",
      requirements: {
        ...issue.delegationContext,
        blockerCount: snapshot.blockerCount,
      },
    });
  }

  return tasks;
}
