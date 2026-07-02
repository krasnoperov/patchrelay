import type { GitHubFailureSource, IssueRecord, WorkflowObservationRecord } from "./db-types.ts";
import { buildFailureContext } from "./idle-reconciliation-helpers.ts";
import { isCurrentHeadRequestedChanges } from "./issue-session.ts";
import { resolvePayloadRunType } from "./issue-session-events.ts";
import { isCanceledLinearState, isCompletedLinearState } from "./pr-state.ts";
import type { RunType } from "./run-type.ts";
import { tryParseRunContextValue, type RunContext } from "./run-context.ts";

// ─── S5 inbox observation types ───────────────────────────────────────
// Append-only *signal* observations that reconciled facts cannot "un-happen":
// human input, completion-check continuation, and orchestration child updates.
// Consumption is itself an observation (`workflow.signal_consumed`), never a
// column, so `deriveWorkflowTasks` stays a pure, monotonic function of the log:
//   unconsumed = signals − ⋃ signal_consumed.payload.consumedObservationIds
export const HUMAN_INPUT_OBSERVATION = "human.input";
export const COMPLETION_CHECK_CONTINUE_OBSERVATION = "executor.completion_check_continue";
export const CHILD_OBSERVATION_TYPES = new Set<string>([
  "orchestration.child_changed",
  "orchestration.child_delivered",
  "orchestration.child_regressed",
]);
export const SIGNAL_CONSUMED_OBSERVATION = "workflow.signal_consumed";

export type WorkflowTaskType = "run" | "verify" | "ask" | "wait" | "publish" | "escalate";

export interface WorkflowAuthority {
  delegated: boolean;
  epoch: number;
  source: "linear" | "operator";
  observedAt?: string | undefined;
}

export interface WorkflowArtifact {
  type: "branch" | "commit" | "pr" | "review" | "check" | "linear_session" | "codex_thread";
  ref: string;
  state?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface WorkflowRunSnapshot {
  id: number;
  runType: RunType;
  authorityEpoch: number;
  status: string;
}

export interface WorkflowTask {
  id: string;
  type: WorkflowTaskType;
  reason: string;
  runType?: RunType | undefined;
  requirements?: Record<string, unknown> | undefined;
}

export interface WorkflowContext {
  issueKey?: string | undefined;
  title?: string | undefined;
  factoryState: IssueRecord["factoryState"];
  lastBlockingReviewHeadSha?: string | undefined;
  lastGitHubFailureSource?: GitHubFailureSource | undefined;
  lastGitHubFailureHeadSha?: string | undefined;
  lastGitHubFailureSignature?: string | undefined;
  lastAttemptedFailureHeadSha?: string | undefined;
  lastAttemptedFailureSignature?: string | undefined;
  failureContext?: RunContext | undefined;
  ciSnapshot?: RunContext["ciSnapshot"] | undefined;
  requestedChangesContext?: RunContext | undefined;
  delegationContext?: RunContext | undefined;
  branchUpkeepContext?: BranchUpkeepContext | undefined;
  // S5: the durable inbox signals behind `run:input` / `run:orchestration_followup`.
  inputInboxContext?: InboxInputContext | undefined;
  orchestrationInboxContext?: OrchestrationInboxContext | undefined;
}

// S5: the resolved shape of one or more unconsumed human.input /
// completion_check_continue observations. `requirements` is the RunContext-shaped
// payload merged from the observations (followUps, directReplyMode,
// completionCheckMode, replacement-PR facts, wakeReason) plus the
// `consumesObservationIds` the claim will mark consumed and a `resumeThread` hint.
export interface InboxInputContext {
  runType: RunType;
  wakeReason: string;
  consumesObservationIds: number[];
  requirements: Record<string, unknown>;
}

// S5: the resolved shape of one or more unconsumed orchestration child_*
// observations for a parent that has already started a thread.
export interface OrchestrationInboxContext {
  consumesObservationIds: number[];
  requirements: Record<string, unknown>;
}

// S2: the durable signal behind a `run:branch_upkeep` task. Mirrors the
// facts the legacy `deriveIssueSessionReactiveIntent` branch_upkeep branch
// reacted to (a stacked child needs a rebase onto a moved parent head, or a
// review-fix left the PR dirty). Sourced from the latest
// `github.parent_head_moved` observation and self-closes once the child's own
// head advances past the head that was current when the parent moved.
export interface BranchUpkeepContext {
  parentBranch?: string | undefined;
  parentHeadSha?: string | undefined;
  childPrNumber?: number | undefined;
}

export interface WorkflowSnapshot {
  id: string;
  projectId: string;
  subjectId: string;
  status: "idle" | "waiting" | "running" | "done" | "failed";
  authority: WorkflowAuthority;
  context: WorkflowContext;
  openTasks: WorkflowTask[];
  activeRun?: WorkflowRunSnapshot | undefined;
  artifacts: WorkflowArtifact[];
  blockerCount: number;
  childCount: number;
  openChildCount: number;
}

export type GateDecision =
  | { action: "start" }
  | { action: "wait"; reason: string }
  | { action: "ask"; reason: string; question: string }
  | { action: "escalate"; reason: string };

export interface WorkflowProjectionInput {
  issue: IssueRecord;
  observations?: WorkflowObservationRecord[] | undefined;
  blockerCount?: number | undefined;
  childCount?: number | undefined;
  openChildCount?: number | undefined;
  activeRun?: WorkflowRunSnapshot | undefined;
}

function parseObservationPayload(observation: WorkflowObservationRecord): Record<string, unknown> | undefined {
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

function deriveAuthority(
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

function issueStatus(issue: IssueRecord, blockerCount: number): WorkflowSnapshot["status"] {
  if (issue.activeRunId !== undefined) return "running";
  if (
    issue.factoryState === "done"
    || issue.prState === "merged"
    || isCompletedLinearState(issue.currentLinearStateType, issue.currentLinearState)
  ) return "done";
  if (issue.factoryState === "failed" || issue.factoryState === "escalated") return "failed";
  if (isCanceledLinearState(issue.currentLinearStateType, issue.currentLinearState)) return "failed";
  if (!issue.delegatedToPatchRelay || blockerCount > 0 || issue.factoryState === "awaiting_input") return "waiting";
  return "idle";
}

function issueArtifacts(issue: IssueRecord): WorkflowArtifact[] {
  const artifacts: WorkflowArtifact[] = [];
  if (issue.branchName) {
    artifacts.push({ type: "branch", ref: issue.branchName });
  }
  if (issue.prNumber !== undefined) {
    artifacts.push({
      type: "pr",
      ref: String(issue.prNumber),
      ...(issue.prState ? { state: issue.prState } : {}),
      metadata: {
        ...(issue.prUrl ? { url: issue.prUrl } : {}),
        ...(issue.prHeadSha ? { headSha: issue.prHeadSha } : {}),
        ...(issue.prReviewState ? { reviewState: issue.prReviewState } : {}),
        ...(issue.prCheckStatus ? { checkStatus: issue.prCheckStatus } : {}),
        ...(issue.prIsDraft ? { isDraft: true } : {}),
      },
    });
  }
  if (issue.threadId) {
    artifacts.push({ type: "codex_thread", ref: issue.threadId });
  }
  if (issue.agentSessionId) {
    artifacts.push({ type: "linear_session", ref: issue.agentSessionId });
  }
  return artifacts;
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
    // Self-closing fact: the child needs upkeep only while its own head is
    // still the one that was current when the parent moved. Once the child
    // rebases (its head advances), a newer observation supersedes this one, or
    // this signal stops matching and the task closes on the next reconcile.
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

function parseObjectJson(raw: string | undefined): Record<string, unknown> | undefined {
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

// S5: exactly-once consumption ledger. The union of every
// `workflow.signal_consumed` observation's `consumedObservationIds`. Because
// consumption is an append-only observation (not a mutable column), this stays
// a pure function of the log — answered input never resurrects, and re-running
// derivation twice on the same log yields the same open-task set.
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

  // Mirror deriveSessionWakePlan's direct_reply downgrade: a reply resumes a
  // review_fix only while the current head still carries requested changes,
  // otherwise it is a plain implementation continuation.
  const currentHeadRequestedChanges = isCurrentHeadRequestedChanges({
    ...(issue.prReviewState ? { prReviewState: issue.prReviewState } : {}),
    ...(issue.prHeadSha ? { prHeadSha: issue.prHeadSha } : {}),
    ...(issue.lastBlockingReviewHeadSha ? { lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha } : {}),
  });

  const context: Record<string, unknown> = {};
  const followUps: Array<{ type: string; text: string; author?: string }> = [];
  const consumesObservationIds: number[] = [];
  let runType: RunType | undefined;
  let wakeReason: string | undefined;

  for (const observation of unconsumed) {
    consumesObservationIds.push(observation.id);
    const payload = parseObservationPayload(observation) ?? {};
    if (observation.type === COMPLETION_CHECK_CONTINUE_OBSERVATION) {
      if (!runType) {
        runType = resolvePayloadRunType(payload.runType, issue)
          ?? (currentHeadRequestedChanges ? "review_fix" : "implementation");
        wakeReason = "completion_check_continue";
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
        wakeReason = inputKind;
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
  if (wakeReason) context.wakeReason = wakeReason;

  const requirements: Record<string, unknown> = {
    ...context,
    consumesObservationIds,
    resumeThread: true,
  };
  // A review_fix start gate (and later completion checks) needs a blocking
  // review head; carry the same one the reconciled-fact review_fix task uses.
  if (runType === "review_fix") {
    const blockingHeadSha = issue.lastBlockingReviewHeadSha ?? issue.prHeadSha;
    if (blockingHeadSha) {
      requirements.blockingHeadSha = blockingHeadSha;
      requirements.requestedChangesHeadSha = blockingHeadSha;
    }
  }

  return { runType, wakeReason: wakeReason ?? "human_input", consumesObservationIds, requirements };
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
  let wakeReason: string | undefined;
  for (const observation of unconsumed) {
    Object.assign(context, parseObservationPayload(observation) ?? {});
    if (!wakeReason) wakeReason = observation.type.replace("orchestration.", "");
  }

  const consumesObservationIds = unconsumed.map((observation) => observation.id);
  return {
    consumesObservationIds,
    requirements: {
      ...context,
      consumesObservationIds,
      resumeThread: true,
      wakeReason: wakeReason ?? "child_changed",
    },
  };
}

export function projectWorkflowSnapshot(input: WorkflowProjectionInput): WorkflowSnapshot {
  const observations = input.observations ?? [];
  const blockerCount = input.blockerCount ?? 0;
  const childCount = input.childCount ?? 0;
  const openChildCount = input.openChildCount ?? childCount;
  const authority = deriveAuthority(input.issue, observations);
  const failureContext = buildFailureContext(input.issue);
  const ciSnapshot = parseCiSnapshotContext(input.issue.lastGitHubCiSnapshotJson);
  const requestedChangesContext = latestRequestedChangesContext(observations, input.issue.lastBlockingReviewHeadSha);
  const delegationContext = latestDelegationContext(observations);
  const branchUpkeepContext = latestBranchUpkeepContext(observations, input.issue.prHeadSha);
  const inputInboxContext = deriveInputInboxContext(input.issue, observations);
  const orchestrationInboxContext = deriveOrchestrationInboxContext(observations);
  const baseSnapshot: Omit<WorkflowSnapshot, "openTasks"> = {
    id: `${input.issue.projectId}:${input.issue.linearIssueId}`,
    projectId: input.issue.projectId,
    subjectId: input.issue.linearIssueId,
    status: input.activeRun ? "running" : issueStatus({ ...input.issue, delegatedToPatchRelay: authority.delegated }, blockerCount),
    authority,
    context: {
      ...(input.issue.issueKey ? { issueKey: input.issue.issueKey } : {}),
      ...(input.issue.title ? { title: input.issue.title } : {}),
      factoryState: input.issue.factoryState,
      ...(input.issue.lastBlockingReviewHeadSha ? { lastBlockingReviewHeadSha: input.issue.lastBlockingReviewHeadSha } : {}),
      ...(input.issue.lastGitHubFailureSource ? { lastGitHubFailureSource: input.issue.lastGitHubFailureSource } : {}),
      ...(input.issue.lastGitHubFailureHeadSha ? { lastGitHubFailureHeadSha: input.issue.lastGitHubFailureHeadSha } : {}),
      ...(input.issue.lastGitHubFailureSignature ? { lastGitHubFailureSignature: input.issue.lastGitHubFailureSignature } : {}),
      ...(input.issue.lastAttemptedFailureHeadSha ? { lastAttemptedFailureHeadSha: input.issue.lastAttemptedFailureHeadSha } : {}),
      ...(input.issue.lastAttemptedFailureSignature ? { lastAttemptedFailureSignature: input.issue.lastAttemptedFailureSignature } : {}),
      ...(failureContext ? { failureContext } : {}),
      ...(ciSnapshot ? { ciSnapshot } : {}),
      ...(requestedChangesContext ? { requestedChangesContext } : {}),
      ...(delegationContext ? { delegationContext } : {}),
      ...(branchUpkeepContext ? { branchUpkeepContext } : {}),
      ...(inputInboxContext ? { inputInboxContext } : {}),
      ...(orchestrationInboxContext ? { orchestrationInboxContext } : {}),
    },
    ...(input.activeRun
      ? { activeRun: input.activeRun }
      : input.issue.activeRunId !== undefined
      ? {
          activeRun: {
            id: input.issue.activeRunId,
            runType: input.issue.pendingRunType ?? "implementation",
            authorityEpoch: authority.epoch,
            status: "running",
          },
        }
      : {}),
    artifacts: issueArtifacts(input.issue),
    blockerCount,
    childCount,
    openChildCount,
  };
  return {
    ...baseSnapshot,
    openTasks: deriveWorkflowTasks(baseSnapshot),
  };
}

export function deriveWorkflowTasks(snapshot: Omit<WorkflowSnapshot, "openTasks">): WorkflowTask[] {
  const tasks: WorkflowTask[] = [];
  if (!snapshot.authority.delegated) {
    return [{
      id: "wait:authority",
      type: "wait",
      reason: "Workflow is waiting for delegated authority",
    }];
  }
  if (snapshot.status === "done") {
    return [];
  }
  if (snapshot.status === "failed") {
    return [];
  }
  if (snapshot.activeRun) {
    return [{
      id: `wait:active-run:${snapshot.activeRun.id}`,
      type: "wait",
      reason: "A run is already active",
    }];
  }
  const issue = snapshot.context;
  const prState = snapshot.artifacts.find((artifact) => artifact.type === "pr")?.state;
  const prHeadSha = snapshot.artifacts.find((artifact) => artifact.type === "pr")?.metadata?.headSha;
  const prReviewState = snapshot.artifacts.find((artifact) => artifact.type === "pr")?.metadata?.reviewState;
  // A draft PR is work-in-progress: implementation continues on it and none of
  // the reactive review/repair/upkeep gates apply. This mirrors
  // `deriveIssueSessionReactiveIntent`, which returns undefined for drafts —
  // the legacy writers routed a delegated draft PR to `run:implementation`.
  const prIsDraft = snapshot.artifacts.find((artifact) => artifact.type === "pr")?.metadata?.isDraft === true;

  // ── Signal computations (hoisted so the S5 inbox precedence can consult
  //    the structural repair/upkeep signals before falling into a wait gate) ──
  const hasPrArtifact = snapshot.artifacts.some((artifact) => artifact.type === "pr");
  const hasThread = snapshot.artifacts.some((artifact) => artifact.type === "codex_thread");
  const branchUpkeepSignalled = hasPrArtifact
    && !prIsDraft
    && (prState === undefined || prState === "open")
    && issue.branchUpkeepContext !== undefined;
  // Legacy `deriveIssueSessionReactiveIntent` precedence: queue_repair first,
  // then ci_repair, then branch_upkeep/review_fix. Hoisted so branch_upkeep and
  // the S5 inbox tasks all yield to a broken merge/CI gate.
  const queueRepairSignalled = !prIsDraft && prState === "open" && issue.lastGitHubFailureSource === "queue_eviction";
  const branchFailureMatchesCurrentHead = !prIsDraft
    && issue.lastGitHubFailureSource === "branch_ci"
    && typeof issue.lastGitHubFailureSignature === "string"
    && typeof issue.lastGitHubFailureHeadSha === "string"
    && typeof prHeadSha === "string"
    && issue.lastGitHubFailureHeadSha === prHeadSha;
  const branchFailureAlreadyAttempted = branchFailureMatchesCurrentHead
    && issue.lastAttemptedFailureHeadSha === issue.lastGitHubFailureHeadSha
    && issue.lastAttemptedFailureSignature === issue.lastGitHubFailureSignature;
  const ciRepairSignalled = prState === "open" && branchFailureMatchesCurrentHead && !branchFailureAlreadyAttempted;
  const structuralRepairSignalled = queueRepairSignalled || ciRepairSignalled || branchUpkeepSignalled;

  // ── S5 inbox precedence ───────────────────────────────────────────────
  // Chosen order (top wins): queue_repair → ci_repair → branch_upkeep → run:input
  // → run:orchestration_followup → the reconciled-fact review_fix/implementation
  // and the wait gates below. Rationale: a broken merge/CI gate or a stale
  // stacked branch is structural and must be fixed before we act on fresher
  // human intent (so those signals mask the inbox). But an unconsumed
  // human.input / completion_check_continue is the *freshest* intent, so it
  // outranks the reconciled-fact review_fix and pre-empts the awaiting_input /
  // wait:blockers / wait:children gates — waiting is not an answer to input that
  // already arrived. run:orchestration_followup overrides wait:children only for
  // a parent that already has a thread; a thread-less parent keeps absorbing
  // child changes under the structural gates (which stay). While a run is
  // active the wait:active-run early return above masks every inbox task; the
  // observations persist and re-derive at release, so no input is lost.
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

  if (issue.factoryState === "awaiting_input") {
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

  // S2: branch_upkeep — a stacked child whose parent PR head moved, or a PR
  // that a review-fix left dirty, needs a rebase onto latest. Mirrors the
  // legacy `deriveIssueSessionReactiveIntent` precedence: queue_repair and
  // ci_repair win first, then branch_upkeep wins over review_fix the same way
  // the reactive intent returned branch_upkeep in place of review_fix on
  // conflict.
  const branchUpkeepTask = (): WorkflowTask => ({
    id: "run:branch_upkeep",
    type: "run",
    runType: "branch_upkeep",
    reason: "Parent PR head moved (or PR left dirty); branch needs upkeep onto latest",
    requirements: {
      branchUpkeepRequired: true,
      reviewFixMode: "branch_upkeep",
      wakeReason: "branch_upkeep",
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
        failureHeadSha: issue.lastGitHubFailureHeadSha ?? prHeadSha,
        ...(issue.ciSnapshot ? { ciSnapshot: issue.ciSnapshot } : {}),
      },
    });
    return tasks;
  }

  if ((!hasPrArtifact || prIsDraft) && issue.factoryState === "delegated") {
    tasks.push({
      id: "run:implementation",
      type: "run",
      runType: "implementation",
      reason: prIsDraft
        ? "Delegated workflow has only a draft PR; implementation continues"
        : "Delegated workflow has no PR artifact yet",
      requirements: {
        ...issue.delegationContext,
        blockerCount: snapshot.blockerCount,
      },
    });
  } else if (!hasPrArtifact) {
    tasks.push({
      id: `wait:${issue.factoryState}`,
      type: "wait",
      reason: `Workflow is waiting in ${issue.factoryState}`,
    });
  }

  return tasks;
}

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
    // Unlike review_fix, branch_upkeep does not require a blocking review head
    // (a stacked child needs a rebase regardless of review). It only needs a
    // live PR to push a new head onto.
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
  if ((task.runType === "ci_repair" || task.runType === "queue_repair") && typeof task.requirements?.failureHeadSha !== "string") {
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
