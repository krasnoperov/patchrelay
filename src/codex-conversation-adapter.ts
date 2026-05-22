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
import { extractLatestAssistantSummary } from "./issue-session-events.ts";

export type CodexConversationInputSource = "agent_session_prompt" | "addressed_issue_comment";

export interface CodexConversationDeliveryResult {
  status: "answered" | "ignored" | "queued" | "steered" | "delivery_failed" | "stopped";
  queuedRunType?: RunType | undefined;
  activeRunType?: RunType | undefined;
}

type ActiveRun = NonNullable<ReturnType<PatchRelayDatabase["runs"]["getRunById"]>>;

export class CodexConversationAdapter {
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
    source: CodexConversationInputSource;
    body: string;
    author?: string | undefined;
    directReply?: boolean | undefined;
    emitActivity?: ((content: LinearAgentActivityContent, options?: { ephemeral?: boolean }) => Promise<void>) | undefined;
    peekPendingSessionWakeRunType?: ((projectId: string, issueId: string) => RunType | undefined) | undefined;
  }): Promise<CodexConversationDeliveryResult> {
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
          eventJson: JSON.stringify({ body, source: params.source, ...(params.author ? { author: params.author } : {}) }),
        });
        this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);
      }
      return { status: "stopped", ...(activeRun?.runType ? { activeRunType: activeRun.runType } : {}) };
    }

    if (!issue.delegatedToPatchRelay) {
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
        emitActivity: params.emitActivity,
      });
    }

    return await this.queueIdleInput({
      project: params.project,
      issue,
      body,
      source: params.source,
      author: params.author,
      directReply: params.directReply === true,
      emitActivity: params.emitActivity,
    });
  }

  private async classify(
    body: string,
    source: CodexConversationInputSource,
    issue: IssueRecord,
    activeRun: ActiveRun | undefined,
    directReply: boolean,
  ): Promise<FollowupIntentClassification | undefined> {
    if (!this.followupClassifier) return undefined;
    return await this.followupClassifier.classify(body, {
      source: source === "agent_session_prompt" ? "agentPrompted" : "comment",
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
    source: CodexConversationInputSource;
    author?: string | undefined;
    emitActivity?: ((content: LinearAgentActivityContent, options?: { ephemeral?: boolean }) => Promise<void>) | undefined;
  }): Promise<CodexConversationDeliveryResult> {
    const { issue, activeRun, body, source } = params;
    if (!activeRun.threadId || !activeRun.turnId) {
      const queuedRunType = this.queueFollowUpEvent(issue, body, source, params.author, false);
      return { status: "queued", ...(queuedRunType ? { queuedRunType } : {}) };
    }

    const input = [
      source === "agent_session_prompt"
        ? "New Linear agent-session prompt received while you are working."
        : "New explicitly addressed Linear issue comment received while you are working.",
      params.author ? `Author: ${params.author}` : undefined,
      "",
      "Checkpoint contract: incorporate this instruction before your next meaningful side effect when possible. If you are already inside a non-interruptible command, finish that command, then re-plan with this input before continuing.",
      "",
      body,
    ].filter(Boolean).join("\n");

    try {
      await this.codex.steerTurn({ threadId: activeRun.threadId, turnId: activeRun.turnId, input });
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
        kind: source === "agent_session_prompt" ? "agent" : "comment",
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
      const queuedRunType = this.queueFollowUpEvent(issue, body, source, params.author, false);
      this.feed?.publish({
        level: "warn",
        kind: source === "agent_session_prompt" ? "agent" : "comment",
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
    source: CodexConversationInputSource;
    author?: string | undefined;
    directReply: boolean;
    emitActivity?: ((content: LinearAgentActivityContent, options?: { ephemeral?: boolean }) => Promise<void>) | undefined;
  }): Promise<CodexConversationDeliveryResult> {
    const originalIssue = params.issue;
    let issue = originalIssue;
    const replacementPrRequired = originalIssue.factoryState === "done" && originalIssue.prNumber !== undefined;
    if (replacementPrRequired) {
      issue = this.prepareReplacementWork(params.project, originalIssue);
    }

    const queuedRunType = this.queueFollowUpEvent(issue, params.body, params.source, params.author, params.directReply, replacementPrRequired ? originalIssue : undefined);
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

  private queueFollowUpEvent(
    issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "factoryState" | "prNumber" | "prUrl" | "prState" | "prHeadSha" | "prReviewState">,
    body: string,
    source: CodexConversationInputSource,
    author: string | undefined,
    directReply: boolean,
    previousIssue?: Pick<IssueRecord, "prNumber" | "prUrl" | "prState" | "prHeadSha"> | undefined,
  ): RunType | undefined {
    return this.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
      eventType: directReply ? "direct_reply" : source === "agent_session_prompt" ? "followup_prompt" : "followup_comment",
      eventJson: JSON.stringify({
        ...(source === "agent_session_prompt" ? { text: body } : { body }),
        source: source === "agent_session_prompt" ? "linear_agent_prompt" : "linear_comment",
        ...(author ? { author } : {}),
        ...(previousIssue?.prNumber !== undefined
          ? {
              replacementPrRequired: true,
              previousPrNumber: previousIssue.prNumber,
              ...(previousIssue.prUrl ? { previousPrUrl: previousIssue.prUrl } : {}),
              ...(previousIssue.prState ? { previousPrState: previousIssue.prState } : {}),
              ...(previousIssue.prHeadSha ? { previousPrHeadSha: previousIssue.prHeadSha } : {}),
            }
          : {}),
      }),
    });
  }

  private prepareReplacementWork(project: ProjectConfig, issue: IssueRecord): IssueRecord {
    const issueRef = (issue.issueKey ?? issue.linearIssueId).replace(/[^a-zA-Z0-9._-]+/g, "-");
    const suffix = Date.now().toString(36);
    return this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
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
    }) ?? issue;
  }

  private async stopActiveRun(
    issue: IssueRecord,
    run: ActiveRun,
    body: string,
    source: CodexConversationInputSource,
  ): Promise<void> {
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
      this.db.runs.finishRun(run.id, { status: "released", threadId: run.threadId, turnId: run.turnId });
    }

    this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: null,
      factoryState: "awaiting_input",
    });
    this.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
      eventType: "stop_requested",
      eventJson: JSON.stringify({ body, source }),
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
    source: CodexConversationInputSource;
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
        source: params.source === "agent_session_prompt" ? "linear_agent_prompt" : "linear_comment",
        runId: params.runId,
        runType: params.runType,
        status: params.status,
        body: params.body,
        primitive: params.primitive,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.error ? { error: params.error } : {}),
      }),
    });
  }
}
