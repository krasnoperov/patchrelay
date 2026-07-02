import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { FollowupIntentClassification, FollowupIntentClassifier } from "./followup-intent.ts";
import type { RunType } from "./factory-state.ts";
import {
  buildFollowupStatusActivity,
  buildNonActionableFollowupActivity,
  buildPromptDeliveryFailedActivity,
  buildPromptDeliveredThought,
} from "./linear-session-reporting.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { deriveIssueStatusNote } from "./status-note.ts";
import type { LinearAgentActivityContent, ProjectConfig } from "./types.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";
import {
  extractLatestAssistantSummary,
  type InputMessageEventPayload,
  type PromptDeliveredEventPayload,
  type StopRequestedEventPayload,
} from "./issue-session-events.ts";
import { dirtyWorktreeEventPayload, inspectGitWorktreeStatus } from "./git-worktree-status.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";
import { HUMAN_INPUT_OBSERVATION, SIGNAL_CONSUMED_OBSERVATION } from "./workflow-runtime.ts";
import { createHash } from "node:crypto";

const WRITER = "agent-input-service";

type HumanInputKind = "direct_reply" | "followup_prompt" | "followup_comment" | "operator_prompt";

function humanInputDedupeKey(linearIssueId: string, text: string, inputKind: HumanInputKind): string {
  const digest = createHash("sha256").update(text).digest("hex");
  return `input:${linearIssueId}:${digest}:${inputKind}`;
}

export interface AgentInputDeliveryResult {
  status: "answered" | "ignored" | "queued" | "steered" | "delivery_failed" | "stopped";
  queuedRunType?: RunType | undefined;
  activeRunType?: RunType | undefined;
}

export type AgentInputSource =
  | "linear_agent_session"
  | "linear_addressed_comment"
  | "patchrelay_operator_prompt";

type ActiveRun = NonNullable<ReturnType<PatchRelayDatabase["runs"]["getRunById"]>>;

export class AgentInputService {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
    private readonly followupClassifier?: FollowupIntentClassifier,
  ) {}

  async deliverAgentInput(params: {
    project: ProjectConfig;
    issue: IssueRecord;
    source: AgentInputSource;
    body: string;
    author?: string | undefined;
    operatorSource?: string | undefined;
    directReply?: boolean | undefined;
    emitActivity?: ((content: LinearAgentActivityContent, options?: { ephemeral?: boolean }) => Promise<void>) | undefined;
    peekPendingSessionWakeRunType?: ((projectId: string, issueId: string) => RunType | undefined) | undefined;
  }): Promise<AgentInputDeliveryResult> {
    const body = params.body.trim();
    if (!body) return { status: "ignored" };

    const issue = this.db.issues.getIssue(params.issue.projectId, params.issue.linearIssueId) ?? params.issue;
    const activeRun = issue.activeRunId ? this.db.runs.getRunById(issue.activeRunId) : undefined;
    const intent = await this.classify(body, params.source, issue, activeRun, params.directReply === true);

    if (intent?.intent === "status" && !params.directReply) {
      await params.emitActivity?.(
        this.buildStatusActivity(issue, activeRun, params.peekPendingSessionWakeRunType, activeRun ? "thought" : "response"),
        activeRun ? { ephemeral: true } : undefined,
      );
      return { status: "answered", ...(activeRun?.runType ? { activeRunType: activeRun.runType } : {}) };
    }

    if (intent?.intent === "stop") {
      if (activeRun) {
        await this.stopActiveRun(issue, activeRun, body, params.source);
      } else {
        this.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
          eventType: "stop_requested",
          eventJson: JSON.stringify({ body, source: params.source, ...(params.author ? { author: params.author } : {}) } satisfies StopRequestedEventPayload),
        });
        this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
      }
      return { status: "stopped", ...(activeRun?.runType ? { activeRunType: activeRun.runType } : {}) };
    }

    if (!issue.delegatedToPatchRelay && !(activeRun && params.source === "patchrelay_operator_prompt")) {
      await params.emitActivity?.({ type: "thought", body: "PatchRelay is paused because the issue is undelegated." }, { ephemeral: true });
      return { status: "ignored" };
    }

    if (activeRun) {
      return await this.steerActiveRun({
        issue,
        activeRun,
        body,
        source: params.source,
        author: params.author,
        operatorSource: params.operatorSource,
        emitActivity: params.emitActivity,
      });
    }

    return await this.queueIdleInput({
      project: params.project,
      issue,
      body,
      source: params.source,
      author: params.author,
      operatorSource: params.operatorSource,
      directReply: params.directReply === true,
      emitActivity: params.emitActivity,
    });
  }

  private async classify(
    body: string,
    source: AgentInputSource,
    issue: IssueRecord,
    activeRun: ActiveRun | undefined,
    directReply: boolean,
  ): Promise<FollowupIntentClassification | undefined> {
    if (source === "patchrelay_operator_prompt") return undefined;
    if (!this.followupClassifier) return undefined;
    return await this.followupClassifier.classify(body, {
      source: source === "linear_agent_session" ? "agentPrompted" : "comment",
      ...(activeRun?.runType ? { activeRunType: activeRun.runType } : {}),
      factoryState: issue.factoryState,
      directReply,
      delegatedToPatchRelay: issue.delegatedToPatchRelay,
      prReviewState: issue.prReviewState,
      explicitWakeIntent: true,
    });
  }

  private async steerActiveRun(params: {
    issue: IssueRecord;
    activeRun: ActiveRun;
    body: string;
    source: AgentInputSource;
    author?: string | undefined;
    operatorSource?: string | undefined;
    emitActivity?: ((content: LinearAgentActivityContent, options?: { ephemeral?: boolean }) => Promise<void>) | undefined;
  }): Promise<AgentInputDeliveryResult> {
    const { issue, activeRun, body, source } = params;
    // S5: human input ALWAYS lands as a durable observation first (dual path
    // with the legacy queueFollowUpEvent below). On a successful steer we mark
    // it consumed; on failure / no-active-turn it stays unconsumed and becomes a
    // run:input task after the active run releases.
    const inputKind = inputSourceEventType(source);
    const observationId = this.appendHumanInputObservation({
      issue,
      text: body,
      inputKind,
      ...(params.author ? { author: params.author } : {}),
      ...(params.operatorSource ? { operatorSource: params.operatorSource } : {}),
    });
    if (!activeRun.threadId || !activeRun.turnId) {
      const queuedRunType = this.queueFollowUpEvent(issue, body, source, params.author, params.operatorSource, false);
      return { status: "queued", ...(queuedRunType ? { queuedRunType } : {}) };
    }

    const input = [
      source === "linear_agent_session"
        ? "New Linear agent-session prompt received while you are working."
        : source === "linear_addressed_comment"
          ? "New explicitly addressed Linear issue comment received while you are working."
          : "New PatchRelay operator prompt received while you are working.",
      params.author ? `Author: ${params.author}` : undefined,
      "",
      "Checkpoint contract: incorporate this instruction before your next meaningful side effect when possible. If you are already inside a non-interruptible command, finish that command, then re-plan with this input before continuing.",
      "",
      body,
    ].filter(Boolean).join("\n");

    try {
      await this.codex.steerTurn({ threadId: activeRun.threadId, turnId: activeRun.turnId, input });
      this.markInputConsumedBySteer(issue, observationId);
      this.recordPromptDelivery({
        issue,
        source,
        runId: activeRun.id,
        runType: activeRun.runType,
        status: "delivered",
        body,
        primitive: "turn/steer",
        threadId: activeRun.threadId,
        turnId: activeRun.turnId,
      });
      this.feed?.publish({
        level: "info",
        kind: inputFeedKind(source),
        projectId: issue.projectId,
        issueKey: issue.issueKey,
        stage: activeRun.runType,
        status: "delivered",
        summary: `Delivered agent input to active ${activeRun.runType} workflow`,
      });
      await params.emitActivity?.(buildPromptDeliveredThought(activeRun.runType), { ephemeral: true });
      return { status: "steered", activeRunType: activeRun.runType };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, error: message }, "Failed to deliver agent input to active Codex turn");
      this.recordPromptDelivery({
        issue,
        source,
        runId: activeRun.id,
        runType: activeRun.runType,
        status: "delivery_failed",
        body,
        primitive: "turn/steer",
        threadId: activeRun.threadId,
        turnId: activeRun.turnId,
        error: message,
      });
      const queuedRunType = this.queueFollowUpEvent(issue, body, source, params.author, params.operatorSource, false);
      this.feed?.publish({
        level: "warn",
        kind: inputFeedKind(source),
        projectId: issue.projectId,
        issueKey: issue.issueKey,
        stage: activeRun.runType,
        status: "delivery_failed",
        summary: `Could not deliver agent input to active ${activeRun.runType} workflow`,
      });
      await params.emitActivity?.(buildPromptDeliveryFailedActivity(activeRun.runType, message));
      return { status: "delivery_failed", activeRunType: activeRun.runType, ...(queuedRunType ? { queuedRunType } : {}) };
    }
  }

  private async queueIdleInput(params: {
    project: ProjectConfig;
    issue: IssueRecord;
    body: string;
    source: AgentInputSource;
    author?: string | undefined;
    operatorSource?: string | undefined;
    directReply: boolean;
    emitActivity?: ((content: LinearAgentActivityContent, options?: { ephemeral?: boolean }) => Promise<void>) | undefined;
  }): Promise<AgentInputDeliveryResult> {
    const originalIssue = params.issue;
    let issue = originalIssue;
    const replacementPrRequired = originalIssue.factoryState === "done" && originalIssue.prNumber !== undefined;
    if (replacementPrRequired) {
      issue = this.prepareReplacementWork(params.project, originalIssue);
    }

    // S5: land the input as a durable inbox observation and reconcile the
    // run:input task BEFORE the legacy queueFollowUpEvent dispatch, so the
    // workflow_task rung (not the session rung) answers this input. The
    // observation is idle-issue durable: it survives a restart and re-derives
    // the task after reconcileKnownWorkflowTasks.
    this.appendHumanInputObservation({
      issue,
      text: params.body,
      inputKind: params.directReply ? "direct_reply" : inputSourceEventType(params.source),
      ...(params.author ? { author: params.author } : {}),
      ...(params.operatorSource ? { operatorSource: params.operatorSource } : {}),
      ...(replacementPrRequired ? { previousIssue: originalIssue } : {}),
    });
    reconcileWorkflowTasksForIssue(this.db, issue);

    // Dual path: the legacy session event is still written, and its
    // recordEventAndDispatch drains the wake — which now resolves to the
    // run:input workflow task reconciled just above (no extra enqueue needed).
    const queuedRunType = this.queueFollowUpEvent(
      issue,
      params.body,
      params.source,
      params.author,
      params.operatorSource,
      params.directReply,
      replacementPrRequired ? originalIssue : undefined,
    );

    if (queuedRunType) {
      await params.emitActivity?.(
        replacementPrRequired
          ? { type: "action", action: "Reopening", parameter: `completed PR #${originalIssue.prNumber} for replacement work` }
          : buildPromptDeliveredThought(queuedRunType),
        { ephemeral: true },
      );
    } else {
      await params.emitActivity?.(buildNonActionableFollowupActivity("unknown_needs_ack"));
    }
    return { status: queuedRunType ? "queued" : "ignored", ...(queuedRunType ? { queuedRunType } : {}) };
  }

  // S5: land human input as a durable `human.input` observation (the v2 inbox).
  // Idempotent via the (project, subject, source, dedupe_key) unique index, so
  // the same text+kind twice yields one observation. Returns the observation id
  // so a successful steer can mark it consumed.
  private appendHumanInputObservation(params: {
    issue: Pick<IssueRecord, "projectId" | "linearIssueId">;
    text: string;
    inputKind: HumanInputKind;
    author?: string | undefined;
    operatorSource?: string | undefined;
    previousIssue?: Pick<IssueRecord, "prNumber" | "prUrl" | "prState" | "prHeadSha"> | undefined;
  }): number {
    const observation = this.db.workflowObservations.appendObservation({
      projectId: params.issue.projectId,
      subjectId: params.issue.linearIssueId,
      source: params.inputKind === "operator_prompt" ? "operator" : "linear",
      type: HUMAN_INPUT_OBSERVATION,
      payloadJson: JSON.stringify({
        text: params.text,
        inputKind: params.inputKind,
        ...(params.author ? { author: params.author } : {}),
        ...(params.operatorSource ? { operatorSource: params.operatorSource } : {}),
        ...(params.previousIssue?.prNumber !== undefined
          ? {
              replacementPrRequired: true,
              previousPrNumber: params.previousIssue.prNumber,
              ...(params.previousIssue.prUrl ? { previousPrUrl: params.previousIssue.prUrl } : {}),
              ...(params.previousIssue.prState ? { previousPrState: params.previousIssue.prState } : {}),
              ...(params.previousIssue.prHeadSha ? { previousPrHeadSha: params.previousIssue.prHeadSha } : {}),
            }
          : {}),
      }),
      dedupeKey: humanInputDedupeKey(params.issue.linearIssueId, params.text, params.inputKind),
    });
    return observation.id;
  }

  // S5 STEER consumption: mark a human.input observation consumed after its
  // instruction was steered into the active turn. The steer dedupe key keeps
  // the append idempotent, and no run:input task ever derives for it.
  private markInputConsumedBySteer(issue: Pick<IssueRecord, "projectId" | "linearIssueId">, observationId: number): void {
    this.db.workflowObservations.appendObservation({
      projectId: issue.projectId,
      subjectId: issue.linearIssueId,
      source: "executor",
      type: SIGNAL_CONSUMED_OBSERVATION,
      payloadJson: JSON.stringify({ consumedObservationIds: [observationId], method: "steer" }),
      dedupeKey: `signal_consumed:steer:${observationId}`,
    });
  }

  private queueFollowUpEvent(
    issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "factoryState" | "prNumber" | "prUrl" | "prState" | "prHeadSha" | "prReviewState">,
    body: string,
    source: AgentInputSource,
    author: string | undefined,
    operatorSource: string | undefined,
    directReply: boolean,
    previousIssue?: Pick<IssueRecord, "prNumber" | "prUrl" | "prState" | "prHeadSha"> | undefined,
  ): RunType | undefined {
    return this.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
      eventType: directReply ? "direct_reply" : inputSourceEventType(source),
      eventJson: JSON.stringify({
        ...(source === "linear_addressed_comment" ? { body } : { text: body }),
        source: inputSourcePayloadSource(source),
        ...(author ? { author } : {}),
        ...(operatorSource ? { operatorSource } : {}),
        ...(previousIssue?.prNumber !== undefined
          ? {
              replacementPrRequired: true,
              previousPrNumber: previousIssue.prNumber,
              ...(previousIssue.prUrl ? { previousPrUrl: previousIssue.prUrl } : {}),
              ...(previousIssue.prState ? { previousPrState: previousIssue.prState } : {}),
              ...(previousIssue.prHeadSha ? { previousPrHeadSha: previousIssue.prHeadSha } : {}),
            }
          : {}),
      } satisfies InputMessageEventPayload),
    });
  }

  private prepareReplacementWork(project: ProjectConfig, issue: IssueRecord): IssueRecord {
    const issueRef = (issue.issueKey ?? issue.linearIssueId).replace(/[^a-zA-Z0-9._-]+/g, "-");
    const suffix = Date.now().toString(36);
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        factoryState: "delegated",
        branchName: `${project.branchPrefix}/${issueRef}-replacement-${suffix}`,
        prNumber: null,
        prUrl: null,
        prState: null,
        prIsDraft: null,
        prHeadSha: null,
        prAuthorLogin: null,
        prReviewState: null,
        prCheckStatus: null,
        lastBlockingReviewHeadSha: null,
      },
    });
    return commit.outcome === "applied" ? commit.issue : issue;
  }

  private async stopActiveRun(
    issue: IssueRecord,
    run: ActiveRun,
    body: string,
    source: AgentInputSource,
  ): Promise<void> {
    const worktreeStatus = issue.worktreePath ? inspectGitWorktreeStatus(issue.worktreePath) : undefined;
    const dirtyPayload = worktreeStatus ? dirtyWorktreeEventPayload(worktreeStatus) : undefined;
    const dirtySummary = typeof dirtyPayload?.summary === "string" ? dirtyPayload.summary : undefined;

    if (run.threadId && run.turnId) {
      try {
        await this.codex.steerTurn({
          threadId: run.threadId,
          turnId: run.turnId,
          input: "STOP: The user has requested you stop working immediately. Do not make further changes. Wrap up and exit.",
        });
      } catch (error) {
        this.logger.warn({ issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) }, "Failed to steer Codex turn for stop request");
      }
    }

    // The stop is an operator fact: the issue slot clear and the run release
    // ride in one transaction, with the run gated on the issue commit.
    this.db.transaction(() => {
      const commit = this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          activeRunId: null,
          factoryState: "awaiting_input",
        },
      });
      if (commit.outcome === "applied" && run.threadId && run.turnId) {
        this.db.runs.finishRun(run.id, {
          status: "released",
          threadId: run.threadId,
          turnId: run.turnId,
          failureReason: dirtySummary ? `Operator stopped run; ${dirtySummary}` : "Operator stopped run",
        });
      }
    });
    this.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
      eventType: "stop_requested",
      eventJson: JSON.stringify({ body, source, ...dirtyPayload } satisfies StopRequestedEventPayload),
    });
    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
    this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(issue.projectId, issue.linearIssueId);
  }

  private buildStatusActivity(
    issue: IssueRecord,
    activeRun: ActiveRun | undefined,
    peekPendingSessionWakeRunType: ((projectId: string, issueId: string) => RunType | undefined) | undefined,
    activityType: "thought" | "response",
  ): LinearAgentActivityContent {
    const latestRun = activeRun ?? this.db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    const latestEvent = this.db.issueSessions.listIssueSessionEvents(issue.projectId, issue.linearIssueId).at(-1);
    const statusNote = deriveIssueStatusNote({
      issue,
      latestRun,
      latestEvent,
      sessionSummary: extractLatestAssistantSummary(latestRun),
      waitingReason: undefined,
    });
    const pendingRunType = peekPendingSessionWakeRunType?.(issue.projectId, issue.linearIssueId);
    return buildFollowupStatusActivity({
      issue,
      ...(statusNote ? { statusNote } : {}),
      ...(activeRun?.runType ? { activeRunType: activeRun.runType } : {}),
      ...(pendingRunType ? { pendingRunType } : {}),
      activityType,
    });
  }

  private recordPromptDelivery(params: {
    issue: Pick<IssueRecord, "projectId" | "linearIssueId">;
    source: AgentInputSource;
    runId: number;
    runType: RunType;
    status: "delivered" | "delivery_failed";
    body: string;
    primitive: string;
    threadId?: string | undefined;
    turnId?: string | undefined;
    error?: string | undefined;
  }): void {
    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(params.issue.projectId, params.issue.linearIssueId, {
      projectId: params.issue.projectId,
      linearIssueId: params.issue.linearIssueId,
      eventType: "prompt_delivered",
      eventJson: JSON.stringify({
        source: inputSourcePayloadSource(params.source),
        runId: params.runId,
        runType: params.runType,
        status: params.status,
        body: params.body,
        primitive: params.primitive,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.error ? { error: params.error } : {}),
      } satisfies PromptDeliveredEventPayload),
    });
  }
}

function inputSourceEventType(source: AgentInputSource): "followup_prompt" | "followup_comment" | "operator_prompt" {
  switch (source) {
    case "linear_agent_session":
      return "followup_prompt";
    case "linear_addressed_comment":
      return "followup_comment";
    case "patchrelay_operator_prompt":
      return "operator_prompt";
  }
}

function inputSourcePayloadSource(source: AgentInputSource): string {
  switch (source) {
    case "linear_agent_session":
      return "linear_agent_prompt";
    case "linear_addressed_comment":
      return "linear_comment";
    case "patchrelay_operator_prompt":
      return "patchrelay_operator_prompt";
  }
}

function inputFeedKind(source: AgentInputSource): "agent" | "comment" {
  return source === "linear_agent_session" ? "agent" : "comment";
}
