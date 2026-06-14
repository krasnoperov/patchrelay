import type { GitHubFailureSource, IssueRecord, WorkflowObservationRecord } from "./db-types.ts";
import { buildFailureContext } from "./idle-reconciliation-helpers.ts";
import { isCurrentHeadRequestedChanges } from "./issue-session.ts";
import type { RunType } from "./factory-state.ts";
import { tryParseRunContextValue, type RunContext } from "./run-context.ts";

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
  if (issue.factoryState === "done" || issue.prState === "merged") return "done";
  if (issue.factoryState === "failed" || issue.factoryState === "escalated") return "failed";
  if (issue.activeRunId !== undefined) return "running";
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

  if (prState === "open" && isCurrentHeadRequestedChanges({
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

  if (prState === "open" && issue.lastGitHubFailureSource === "queue_eviction") {
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

  const branchFailureMatchesCurrentHead = issue.lastGitHubFailureSource === "branch_ci"
    && typeof issue.lastGitHubFailureSignature === "string"
    && typeof issue.lastGitHubFailureHeadSha === "string"
    && typeof prHeadSha === "string"
    && issue.lastGitHubFailureHeadSha === prHeadSha;
  const branchFailureAlreadyAttempted = branchFailureMatchesCurrentHead
    && issue.lastAttemptedFailureHeadSha === issue.lastGitHubFailureHeadSha
    && issue.lastAttemptedFailureSignature === issue.lastGitHubFailureSignature;

  if (prState === "open" && branchFailureMatchesCurrentHead && !branchFailureAlreadyAttempted) {
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

  if (!snapshot.artifacts.some((artifact) => artifact.type === "pr") && issue.factoryState === "delegated") {
    tasks.push({
      id: "run:implementation",
      type: "run",
      runType: "implementation",
      reason: "Delegated workflow has no PR artifact yet",
      requirements: {
        ...issue.delegationContext,
        blockerCount: snapshot.blockerCount,
      },
    });
  } else if (!snapshot.artifacts.some((artifact) => artifact.type === "pr")) {
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
    if (currentHeadSha === failureHeadSha) {
      return { action: "escalate", reason: "same_head_repair_handoff_blocked" };
    }
  }
  return { action: "start" };
}
