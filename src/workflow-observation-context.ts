import type { IssueRecord, WorkflowObservationRecord } from "./db-types.ts";
import { buildFailureContext } from "./idle-reconciliation-helpers.ts";
import { resolvePayloadRunType } from "./issue-session-events.ts";
import { isCurrentHeadRequestedChanges } from "./reactive-workflow-intent.ts";
import { tryParseRunContextValue, type RunContext } from "./run-context.ts";
import type { RunType } from "./run-type.ts";
import {
  CHILD_OBSERVATION_TYPES,
  COMPLETION_CHECK_CONTINUE_OBSERVATION,
  HUMAN_INPUT_OBSERVATION,
  SIGNAL_CONSUMED_OBSERVATION,
  type BranchUpkeepContext,
  type InboxInputContext,
  type OrchestrationInboxContext,
  type WorkflowAuthority,
  type WorkflowContext,
} from "./workflow-model.ts";

export function parseObservationPayload(observation: WorkflowObservationRecord): Record<string, unknown> | undefined {
  if (!observation.payloadJson) return undefined;
  try {
    const parsed = JSON.parse(observation.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseObjectJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function deriveAuthority(
  issue: Pick<IssueRecord, "delegatedToPatchRelay">,
  observations: WorkflowObservationRecord[],
): WorkflowAuthority {
  let delegated = issue.delegatedToPatchRelay;
  let epoch = 0;
  let source: WorkflowAuthority["source"] = "linear";
  let observedAt: string | undefined;

  for (const observation of observations) {
    if (observation.type !== "linear.delegated" && observation.type !== "linear.undelegated" && observation.type !== "operator.authority_changed") {
      continue;
    }
    epoch += 1;
    source = observation.source === "operator" ? "operator" : "linear";
    observedAt = observation.observedAt;
    const payload = parseObservationPayload(observation);
    if (typeof payload?.delegated === "boolean") {
      delegated = payload.delegated;
      continue;
    }
    delegated = observation.type !== "linear.undelegated";
  }

  return {
    delegated,
    epoch,
    source,
    ...(observedAt ? { observedAt } : {}),
  };
}

function parseCiSnapshotContext(raw: string | undefined): RunContext["ciSnapshot"] | undefined {
  const payload = parseObjectJson(raw);
  if (!payload) return undefined;
  return tryParseRunContextValue({ ciSnapshot: payload })?.ciSnapshot;
}

function latestRequestedChangesContext(
  observations: WorkflowObservationRecord[],
  blockingHeadSha: string | undefined,
): RunContext | undefined {
  for (const observation of [...observations].reverse()) {
    if (observation.source !== "github" || observation.type !== "github.review_changes_requested") {
      continue;
    }
    const payload = parseObservationPayload(observation);
    const rawContext = payload?.requestedChangesContext;
    const context = rawContext && typeof rawContext === "object" && !Array.isArray(rawContext)
      ? tryParseRunContextValue(rawContext as Record<string, unknown>)
      : tryParseRunContextValue(payload ?? {});
    if (!context) continue;
    if (
      blockingHeadSha
      && context.requestedChangesHeadSha
      && context.requestedChangesHeadSha !== blockingHeadSha
    ) {
      continue;
    }
    return context;
  }
  return undefined;
}

function latestDelegationContext(observations: WorkflowObservationRecord[]): RunContext | undefined {
  for (const observation of [...observations].reverse()) {
    if (observation.source !== "linear" || observation.type !== "linear.delegated") {
      continue;
    }
    const payload = parseObservationPayload(observation);
    const context = tryParseRunContextValue({
      ...(typeof payload?.promptContext === "string" ? { promptContext: payload.promptContext } : {}),
      ...(typeof payload?.promptBody === "string" ? { promptBody: payload.promptBody } : {}),
    });
    if (context && Object.keys(context).length > 0) {
      return context;
    }
  }
  return undefined;
}

function latestBranchUpkeepContext(
  observations: WorkflowObservationRecord[],
  issuePrHeadSha: string | undefined,
): BranchUpkeepContext | undefined {
  for (const observation of [...observations].reverse()) {
    if (observation.source !== "github" || observation.type !== "github.parent_head_moved") {
      continue;
    }
    const payload = parseObservationPayload(observation);
    const childHeadSha = payload?.childHeadSha;
    if (typeof childHeadSha === "string" && issuePrHeadSha && childHeadSha !== issuePrHeadSha) {
      continue;
    }
    return {
      ...(typeof payload?.parentBranch === "string" ? { parentBranch: payload.parentBranch } : {}),
      ...(typeof payload?.parentHeadSha === "string" ? { parentHeadSha: payload.parentHeadSha } : {}),
      ...(typeof payload?.childPrNumber === "number" ? { childPrNumber: payload.childPrNumber } : {}),
    };
  }
  return undefined;
}

function consumedObservationIdSet(observations: WorkflowObservationRecord[]): Set<number> {
  const consumed = new Set<number>();
  for (const observation of observations) {
    if (observation.type !== SIGNAL_CONSUMED_OBSERVATION) continue;
    const payload = parseObservationPayload(observation);
    const ids = payload?.consumedObservationIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === "number") consumed.add(id);
    }
  }
  return consumed;
}

function deriveInputInboxContext(
  issue: Pick<IssueRecord, "prReviewState" | "prHeadSha" | "lastBlockingReviewHeadSha">,
  observations: WorkflowObservationRecord[],
): InboxInputContext | undefined {
  const consumed = consumedObservationIdSet(observations);
  const unconsumed = observations.filter((observation) => (
    (observation.type === HUMAN_INPUT_OBSERVATION || observation.type === COMPLETION_CHECK_CONTINUE_OBSERVATION)
    && !consumed.has(observation.id)
  ));
  if (unconsumed.length === 0) return undefined;

  const currentHeadRequestedChanges = isCurrentHeadRequestedChanges({
    ...(issue.prReviewState ? { prReviewState: issue.prReviewState } : {}),
    ...(issue.prHeadSha ? { prHeadSha: issue.prHeadSha } : {}),
    ...(issue.lastBlockingReviewHeadSha ? { lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha } : {}),
  });

  const context: Record<string, unknown> = {};
  const followUps: Array<{ type: string; text: string; author?: string }> = [];
  const consumesObservationIds: number[] = [];
  let runType: RunType | undefined;
  let workflowReason: string | undefined;

  for (const observation of unconsumed) {
    consumesObservationIds.push(observation.id);
    const payload = parseObservationPayload(observation) ?? {};
    if (observation.type === COMPLETION_CHECK_CONTINUE_OBSERVATION) {
      if (!runType) {
        runType = resolvePayloadRunType(payload.runType, issue)
          ?? (currentHeadRequestedChanges ? "review_fix" : "implementation");
        workflowReason = "completion_check_continue";
      }
      Object.assign(context, payload);
      const summary = typeof payload.completionCheckSummary === "string"
        ? payload.completionCheckSummary
        : typeof payload.summary === "string" ? payload.summary : undefined;
      if (summary?.trim()) context.completionCheckSummary = summary.trim();
      context.completionCheckMode = true;
    } else {
      const inputKind = typeof payload.inputKind === "string" ? payload.inputKind : "followup_prompt";
      if (!runType) {
        runType = currentHeadRequestedChanges ? "review_fix" : "implementation";
        workflowReason = inputKind;
      }
      const text = typeof payload.text === "string" ? payload.text
        : typeof payload.body === "string" ? payload.body : undefined;
      if (text) {
        followUps.push({
          type: inputKind,
          text,
          ...(typeof payload.author === "string" ? { author: payload.author } : {}),
        });
      }
      if (inputKind === "direct_reply") context.directReplyMode = true;
      if (payload.replacementPrRequired === true) {
        context.replacementPrRequired = true;
        if (typeof payload.previousPrNumber === "number") context.previousPrNumber = payload.previousPrNumber;
        if (typeof payload.previousPrUrl === "string") context.previousPrUrl = payload.previousPrUrl;
        if (typeof payload.previousPrState === "string") context.previousPrState = payload.previousPrState;
        if (typeof payload.previousPrHeadSha === "string") context.previousPrHeadSha = payload.previousPrHeadSha;
      }
    }
  }

  if (!runType) return undefined;
  if (followUps.length > 0) {
    context.followUps = followUps;
    context.followUpMode = true;
    context.followUpCount = followUps.length;
  }
  if (workflowReason) context.workflowReason = workflowReason;

  const requirements: Record<string, unknown> = {
    ...context,
    consumesObservationIds,
    resumeThread: true,
  };
  if (runType === "review_fix") {
    const blockingHeadSha = issue.lastBlockingReviewHeadSha ?? issue.prHeadSha;
    if (blockingHeadSha) {
      requirements.blockingHeadSha = blockingHeadSha;
      requirements.requestedChangesHeadSha = blockingHeadSha;
    }
  }

  return { runType, workflowReason: workflowReason ?? "human_input", consumesObservationIds, requirements };
}

function deriveOrchestrationInboxContext(
  observations: WorkflowObservationRecord[],
): OrchestrationInboxContext | undefined {
  const consumed = consumedObservationIdSet(observations);
  const unconsumed = observations.filter((observation) => (
    CHILD_OBSERVATION_TYPES.has(observation.type) && !consumed.has(observation.id)
  ));
  if (unconsumed.length === 0) return undefined;

  const context: Record<string, unknown> = {};
  let workflowReason: string | undefined;
  for (const observation of unconsumed) {
    Object.assign(context, parseObservationPayload(observation) ?? {});
    if (!workflowReason) workflowReason = observation.type.replace("orchestration.", "");
  }

  const consumesObservationIds = unconsumed.map((observation) => observation.id);
  return {
    consumesObservationIds,
    requirements: {
      ...context,
      consumesObservationIds,
      resumeThread: true,
      workflowReason: workflowReason ?? "child_changed",
    },
  };
}

export function deriveWorkflowContext(
  issue: IssueRecord,
  observations: WorkflowObservationRecord[],
): WorkflowContext {
  const failureContext = buildFailureContext(issue);
  const ciSnapshot = parseCiSnapshotContext(issue.lastGitHubCiSnapshotJson);
  const requestedChangesContext = latestRequestedChangesContext(observations, issue.lastBlockingReviewHeadSha);
  const delegationContext = latestDelegationContext(observations);
  const branchUpkeepContext = latestBranchUpkeepContext(observations, issue.prHeadSha);
  const inputInboxContext = deriveInputInboxContext(issue, observations);
  const orchestrationInboxContext = deriveOrchestrationInboxContext(observations);

  return {
    ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
    ...(issue.title ? { title: issue.title } : {}),
    ...(issue.inputRequestKind ? { inputRequestKind: issue.inputRequestKind } : {}),
    ...(issue.lastBlockingReviewHeadSha ? { lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha } : {}),
    ...(issue.lastGitHubFailureSource ? { lastGitHubFailureSource: issue.lastGitHubFailureSource } : {}),
    ...(issue.lastGitHubFailureHeadSha ? { lastGitHubFailureHeadSha: issue.lastGitHubFailureHeadSha } : {}),
    ...(issue.lastGitHubFailureSignature ? { lastGitHubFailureSignature: issue.lastGitHubFailureSignature } : {}),
    ...(issue.lastAttemptedFailureHeadSha ? { lastAttemptedFailureHeadSha: issue.lastAttemptedFailureHeadSha } : {}),
    ...(issue.lastAttemptedFailureSignature ? { lastAttemptedFailureSignature: issue.lastAttemptedFailureSignature } : {}),
    ...(failureContext ? { failureContext } : {}),
    ...(ciSnapshot ? { ciSnapshot } : {}),
    ...(requestedChangesContext ? { requestedChangesContext } : {}),
    ...(delegationContext ? { delegationContext } : {}),
    ...(branchUpkeepContext ? { branchUpkeepContext } : {}),
    ...(inputInboxContext ? { inputInboxContext } : {}),
    ...(orchestrationInboxContext ? { orchestrationInboxContext } : {}),
  };
}
