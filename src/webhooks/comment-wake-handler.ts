import type { Logger } from "pino";
import type { CodexAppServerClient } from "../codex-app-server.ts";
import type { PatchRelayDatabase } from "../db.ts";
import { classifyFollowupIntent, followupIntentIsNonActionable, followupIntentQueuesWork } from "../followup-intent.ts";
import type { RunType } from "../factory-state.ts";
import type { OperatorEventFeed } from "../operator-feed.ts";
import { triggerEventAllowed } from "../project-resolution.ts";
import {
  hasExplicitPatchRelayWakeIntent,
  isInertPatchRelayComment,
  isPatchRelayManagedCommentAuthor,
} from "./comment-policy.ts";
import { classifyIssue } from "../issue-class.ts";
import type { NormalizedEvent, ProjectConfig, TrackedIssueRecord } from "../types.ts";

const ENQUEUEABLE_STATES = new Set(["pr_open", "changes_requested", "implementing", "delegated", "awaiting_input"]);

export class CommentWakeHandler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async handle(params: {
    normalized: NormalizedEvent;
    project: ProjectConfig;
    trackedIssue: TrackedIssueRecord | undefined;
    isDirectReplyToOutstandingQuestion: (issue: ReturnType<PatchRelayDatabase["getIssue"]>) => boolean;
    enqueuePendingSessionWake: (projectId: string, issueId: string) => RunType | undefined;
    peekPendingSessionWakeRunType: (projectId: string, issueId: string) => RunType | undefined;
  }): Promise<void> {
    const { normalized, project, trackedIssue } = params;
    if (
      (normalized.triggerEvent !== "commentCreated" && normalized.triggerEvent !== "commentUpdated")
      || !normalized.comment?.body
      || !normalized.issue
    ) {
      return;
    }
    if (!triggerEventAllowed(project, normalized.triggerEvent)) return;

    const issue = this.db.issues.getIssue(project.id, normalized.issue.id);
    if (!issue) return;
    const issueClass = classifyIssue({
      issue,
      childIssueCount: this.db.issues.listChildIssues(project.id, normalized.issue.id).length,
    }).issueClass;
    const trimmedBody = normalized.comment.body.trim();

    const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
    const selfAuthored = isPatchRelayManagedCommentAuthor(installation, normalized.actor, normalized.comment.userName);
    const inertPatchRelayComment = isInertPatchRelayComment(issue, normalized.comment.id, trimmedBody, normalized.actor?.type);
    if (selfAuthored || inertPatchRelayComment) {
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        eventType: "self_comment",
        eventJson: JSON.stringify({
          body: trimmedBody,
          author: normalized.comment.userName,
        }),
      });
      return;
    }

    if (!issue.delegatedToPatchRelay) {
      this.feed?.publish({
        level: "info",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        status: "ignored_undelegated",
        summary: "Ignored comment because the issue is undelegated",
        detail: trimmedBody.slice(0, 200),
      });
      return;
    }

    const directReply = params.isDirectReplyToOutstandingQuestion(issue);
    const intent = classifyFollowupIntent(trimmedBody);

    if (!issue.activeRunId) {
      if (ENQUEUEABLE_STATES.has(issue.factoryState)) {
        const wakeIntent = issueClass === "orchestration" || directReply || hasExplicitPatchRelayWakeIntent(trimmedBody);
        if (!wakeIntent) {
          this.feed?.publish({
            level: "info",
            kind: "comment",
            projectId: project.id,
            issueKey: trackedIssue?.issueKey,
            status: "ignored",
            summary: "Ignored comment with no explicit PatchRelay wake intent",
            detail: trimmedBody.slice(0, 200),
          });
          return;
        }
        if (intent === "stop") {
          this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
            projectId: project.id,
            linearIssueId: normalized.issue.id,
            eventType: "stop_requested",
            eventJson: JSON.stringify({
              body: trimmedBody,
              author: normalized.comment.userName,
            }),
          });
          this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(project.id, normalized.issue.id);
          this.feed?.publish({
            level: "info",
            kind: "comment",
            projectId: project.id,
            issueKey: trackedIssue?.issueKey,
            status: "stopped",
            summary: "Stop request recorded from Linear comment",
            detail: trimmedBody.slice(0, 200),
          });
          return;
        }
        if (!directReply && !followupIntentQueuesWork(intent)) {
          this.feed?.publish({
            level: "info",
            kind: "comment",
            projectId: project.id,
            issueKey: trackedIssue?.issueKey,
            status: intent === "status" ? "status_requested" : "ignored",
            summary: intent === "status"
              ? "Ignored status comment without queueing work"
              : "Ignored non-actionable follow-up comment",
            detail: trimmedBody.slice(0, 200),
          });
          return;
        }
        const runType = issue.prReviewState === "changes_requested" ? "review_fix" : "implementation";
        const hadPendingWake = this.db.issueSessions.peekIssueSessionWake(project.id, normalized.issue.id) !== undefined;
        this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
          projectId: project.id,
          linearIssueId: normalized.issue.id,
          eventType: directReply ? "direct_reply" : "followup_comment",
          eventJson: JSON.stringify({
            body: trimmedBody,
            author: normalized.comment.userName,
          }),
        });
        const queuedRunType = hadPendingWake
          ? params.peekPendingSessionWakeRunType(project.id, normalized.issue.id)
          : params.enqueuePendingSessionWake(project.id, normalized.issue.id);
        this.feed?.publish({
          level: "info",
          kind: "comment",
          projectId: project.id,
          issueKey: trackedIssue?.issueKey,
          status: "enqueued",
          summary: `Comment enqueued ${(queuedRunType ?? runType)} run`,
          detail: trimmedBody.slice(0, 200),
        });
      }
      return;
    }

    const run = this.db.runs.getRunById(issue.activeRunId);
    if (!run?.threadId || !run.turnId) return;

    if (intent === "stop") {
      try {
        await this.codex.steerTurn({
          threadId: run.threadId,
          turnId: run.turnId,
          input: "STOP: The user has requested you stop working immediately. Do not make further changes. Wrap up and exit.",
        });
      } catch (error) {
        this.logger.warn({ issueKey: trackedIssue?.issueKey, error: error instanceof Error ? error.message : String(error) }, "Failed to steer Codex turn for comment stop request");
      }
      this.db.runs.finishRun(run.id, { status: "released", threadId: run.threadId, turnId: run.turnId });
      this.db.issueSessions.upsertIssueRespectingActiveLease(project.id, normalized.issue.id, {
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        activeRunId: null,
        factoryState: "awaiting_input",
      });
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        eventType: "stop_requested",
        eventJson: JSON.stringify({
          body: trimmedBody,
          author: normalized.comment.userName,
        }),
      });
      this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(project.id, normalized.issue.id);
      this.feed?.publish({
        level: "info",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        stage: run.runType,
        status: "stopped",
        summary: "Stop request delivered to active workflow",
      });
      return;
    }

    if (!directReply && followupIntentIsNonActionable(intent)) {
      this.feed?.publish({
        level: "info",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        stage: run.runType,
        status: intent === "status" ? "status_requested" : "ignored",
        summary: intent === "status"
          ? "Ignored status comment without steering active workflow"
          : "Ignored non-actionable follow-up comment",
        detail: trimmedBody.slice(0, 200),
      });
      return;
    }

    const body = [
      "New Linear comment received while you are working.",
      normalized.comment.userName ? `Author: ${normalized.comment.userName}` : undefined,
      "",
      trimmedBody,
    ].filter(Boolean).join("\n");

    try {
      await this.codex.steerTurn({ threadId: run.threadId, turnId: run.turnId, input: body });
      this.feed?.publish({
        level: "info",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        stage: run.runType,
        status: "delivered",
        summary: `Delivered follow-up comment to active ${run.runType} workflow`,
      });
    } catch (error) {
      this.logger.warn({ issueKey: trackedIssue?.issueKey, error: error instanceof Error ? error.message : String(error) }, "Failed to deliver follow-up comment");
      const hadPendingWake = this.db.issueSessions.hasPendingIssueSessionEvents(project.id, normalized.issue.id);
      const directReply = params.isDirectReplyToOutstandingQuestion(issue);
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(project.id, normalized.issue.id, {
        projectId: project.id,
        linearIssueId: normalized.issue.id,
        eventType: directReply ? "direct_reply" : "followup_comment",
        eventJson: JSON.stringify({
          body: trimmedBody,
          author: normalized.comment.userName,
        }),
      });
      if (!hadPendingWake) {
        params.enqueuePendingSessionWake(project.id, normalized.issue.id);
      }
      this.feed?.publish({
        level: "warn",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        stage: run.runType,
        status: "delivery_failed",
        summary: `Could not deliver follow-up comment to active ${run.runType} workflow`,
      });
    }
  }
}
