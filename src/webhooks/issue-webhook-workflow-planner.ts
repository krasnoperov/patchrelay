import { resolveAwaitingInputReason, type AwaitingInputReason } from "../awaiting-input-reason.ts";
import { computeOrchestrationSettleUntil as computeDefaultOrchestrationSettleUntil } from "../orchestration-parent-dispatch.ts";
import { classifyIssue } from "../issue-class.ts";
import type { IssueMetadata, IssueRecord } from "../types.ts";
import type { RunType } from "../run-type.ts";
import type { TriggerEvent } from "../workflow-types.ts";
import type { WorkflowRunIntent } from "../workflow-intent.ts";
import type { resolveLinkedPrAdoption } from "./linked-pr-adoption.ts";
import {
  decideActiveRunRelease,
  decideAgentSession,
  decideRunIntent,
  decideUnDelegation,
  isTerminalDelegationState,
  resolveReDelegationResume,
} from "./decision-helpers.ts";
import { resolveIssueUpdatePlan, type ResolvedIssueUpdate } from "./issue-update-plan.ts";

type LinkedPrAdoptionResult = Exclude<Awaited<ReturnType<typeof resolveLinkedPrAdoption>>, undefined>;

export interface IssueWebhookWorkflowPlannerInput {
  existingIssue: IssueRecord | undefined;
  hydratedIssue: IssueMetadata;
  latestRun?: Parameters<typeof resolveAwaitingInputReason>[0]["latestRun"];
  delegated: boolean;
  linkedPrAdoption?: LinkedPrAdoptionResult | undefined;
  triggerAllowed: boolean;
  triggerEvent: TriggerEvent;
  unresolvedBlockers: number;
  hasActiveRun: boolean;
  activeRunType?: RunType | undefined;
  hasRunnableWorkflowTask: boolean;
  existingWorkflowTaskRunType?: RunType | undefined;
  incomingAgentSessionId?: string | undefined;
  childIssueCount: number;
  computeOrchestrationSettleUntil?: () => string;
}

export interface IssueWebhookWorkflowPlan {
  classification: ReturnType<typeof classifyIssue>;
  terminal: boolean;
  desiredStage: RunType | undefined;
  blockerPausedImplementation: boolean;
  undelegation: ReturnType<typeof decideUnDelegation>;
  startupResume: {
    workflowIntent?: WorkflowRunIntent | undefined;
    source: "linked_pr_adoption" | "re_delegated";
  };
  effectiveRunRelease: ReturnType<typeof decideActiveRunRelease>;
  clearPending: boolean;
  agentSessionId: string | null | undefined;
  shouldEnterOrchestrationSettle: boolean;
  resolvedIssueUpdate: ResolvedIssueUpdate;
}

function resolveStartupResume(input: IssueWebhookWorkflowPlannerInput): IssueWebhookWorkflowPlan["startupResume"] {
  if (input.linkedPrAdoption) {
    return {
      workflowIntent: input.linkedPrAdoption.workflowIntent,
      source: "linked_pr_adoption",
    };
  }

  const awaitingInputReason: AwaitingInputReason | undefined = input.existingIssue
    ? resolveAwaitingInputReason({ issue: input.existingIssue, latestRun: input.latestRun })
    : undefined;

  return {
    ...resolveReDelegationResume({
      delegated: input.delegated,
      previouslyDelegated: input.existingIssue?.delegatedToPatchRelay,
      awaitingInputReason,
      unresolvedBlockers: input.unresolvedBlockers,
      prNumber: input.existingIssue?.prNumber,
      prState: input.existingIssue?.prState,
      prIsDraft: input.existingIssue?.prIsDraft,
      prReviewState: input.existingIssue?.prReviewState,
      prCheckStatus: input.existingIssue?.prCheckStatus,
      latestFailureSource: input.existingIssue?.lastGitHubFailureSource,
    }),
    source: "re_delegated",
  };
}

export function planIssueWebhookWorkflow(input: IssueWebhookWorkflowPlannerInput): IssueWebhookWorkflowPlan {
  const terminal = isTerminalDelegationState(input.existingIssue, input.hydratedIssue);
  const openPrExists = input.existingIssue?.prNumber !== undefined
    && input.existingIssue.prState !== "closed"
    && input.existingIssue.prState !== "merged";
  const blockerPausedImplementation = input.unresolvedBlockers > 0
    && input.activeRunType === "implementation"
    && !openPrExists;

  const desiredStage = input.linkedPrAdoption
    ? undefined
    : decideRunIntent({
      delegated: input.delegated,
      triggerAllowed: input.triggerAllowed,
      triggerEvent: input.triggerEvent,
      unresolvedBlockers: input.unresolvedBlockers,
      hasActiveRun: input.hasActiveRun,
      hasRunnableWorkflowTask: input.hasRunnableWorkflowTask,
      terminal,
      inputRequestKind: input.existingIssue?.inputRequestKind,
    });

  const classification = classifyIssue({
    issue: {
      issueClass: input.existingIssue?.issueClass,
      issueClassSource: input.existingIssue?.issueClassSource,
      title: input.hydratedIssue.title ?? input.existingIssue?.title,
      description: input.hydratedIssue.description ?? input.existingIssue?.description,
      parentLinearIssueId: input.hydratedIssue.parentId ?? input.existingIssue?.parentLinearIssueId,
    },
    childIssueCount: input.childIssueCount,
  });

  const shouldEnterOrchestrationSettle = Boolean(
    input.delegated
    && desiredStage === "implementation"
    && classification.issueClass === "orchestration"
    && input.childIssueCount === 0
    && !input.existingIssue?.threadId
    && !input.hasActiveRun
    && !terminal,
  );

  const runRelease = decideActiveRunRelease({
    hasActiveRun: input.hasActiveRun,
    terminal,
    triggerEvent: input.triggerEvent,
    delegated: input.delegated,
  });
  const effectiveRunRelease = blockerPausedImplementation
    ? { release: true, reason: "Issue became blocked during implementation" }
    : runRelease;

  const undelegation = decideUnDelegation({
    triggerEvent: input.triggerEvent,
    delegated: input.delegated,
    terminal,
    hasPr: input.existingIssue?.prNumber !== undefined && input.existingIssue?.prState !== "merged",
  });
  const startupResume = resolveStartupResume(input);
  const clearPending = (input.unresolvedBlockers > 0 && input.existingWorkflowTaskRunType === "implementation" && !input.hasActiveRun)
    || undelegation.clearPending;
  const agentSessionId = decideAgentSession({
    sessionId: input.incomingAgentSessionId,
    triggerEvent: input.triggerEvent,
    delegated: input.delegated,
  });
  const resolvedIssueUpdate = resolveIssueUpdatePlan({
    existingIssue: Boolean(input.existingIssue),
    existingInputRequestKind: input.existingIssue?.inputRequestKind,
    delegated: input.delegated,
    incomingAgentSessionId: input.incomingAgentSessionId,
    startupResume,
    desiredStage,
    blockerPausedImplementation,
    undelegation,
    effectiveRunRelease,
    shouldEnterOrchestrationSettle,
    agentSessionId,
    computeOrchestrationSettleUntil: input.computeOrchestrationSettleUntil ?? computeDefaultOrchestrationSettleUntil,
  });

  return {
    classification,
    terminal,
    desiredStage,
    blockerPausedImplementation,
    undelegation,
    startupResume,
    effectiveRunRelease,
    clearPending,
    agentSessionId,
    shouldEnterOrchestrationSettle,
    resolvedIssueUpdate,
  };
}
