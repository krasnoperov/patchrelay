import type { Logger } from "pino";
import type { CodexAppServerClient } from "../codex-app-server.ts";
import type { PatchRelayDatabase } from "../db.ts";
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
      trackedDependentCount: this.db.issues.listDependents(project.id, normalized.issue.id).length,
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

    if (!issue.activeRunId) {
      if (ENQUEUEABLE_STATES.has(issue.factoryState)) {
        const directReply = params.isDirectReplyToOutstandingQuestion(issue);
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
