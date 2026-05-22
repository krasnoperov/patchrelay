import type { CodexConversationAdapter } from "../codex-conversation-adapter.ts";
import type { PatchRelayDatabase } from "../db.ts";
import type { OperatorEventFeed } from "../operator-feed.ts";
import { triggerEventAllowed } from "../project-resolution.ts";
import {
  extractPatchRelayAddressedText,
  isInertPatchRelayComment,
  isPatchRelayManagedCommentAuthor,
} from "./comment-policy.ts";
import type { LinearAgentActivityContent, NormalizedEvent, ProjectConfig, TrackedIssueRecord } from "../types.ts";
import type { WakeDispatcher } from "../wake-dispatcher.ts";

export class CommentWakeHandler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly feed?: OperatorEventFeed,
    private readonly conversationAdapter?: CodexConversationAdapter,
    private readonly emitLinearActivity?: (
      issue: NonNullable<ReturnType<PatchRelayDatabase["getIssue"]>>,
      content: LinearAgentActivityContent,
      options?: { ephemeral?: boolean },
    ) => Promise<void>,
  ) {}

  async handle(params: {
    normalized: NormalizedEvent;
    project: ProjectConfig;
    trackedIssue: TrackedIssueRecord | undefined;
    isDirectReplyToOutstandingQuestion: (issue: ReturnType<PatchRelayDatabase["getIssue"]>) => boolean;
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
    const trimmedBody = normalized.comment.body.trim();

    const installation = this.db.linearInstallations.getLinearInstallationForProject(project.id);
    const selfAuthored = isPatchRelayManagedCommentAuthor(installation, normalized.actor, normalized.comment.userName);
    const inertPatchRelayComment = isInertPatchRelayComment(issue, normalized.comment.id, trimmedBody, normalized.actor?.type);
    if (selfAuthored || inertPatchRelayComment) {
      this.wakeDispatcher.recordEventAndDispatch(project.id, normalized.issue.id, {
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

    const addressedText = extractPatchRelayAddressedText(trimmedBody);
    if (!addressedText) {
      this.feed?.publish({
        level: "info",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        status: "ignored",
        summary: "Ignored issue comment because it did not address PatchRelay",
        detail: trimmedBody.slice(0, 200),
      });
      return;
    }

    const result = await this.conversationAdapter?.deliverAgentInput({
      project,
      issue,
      source: "addressed_issue_comment",
      body: addressedText,
      author: normalized.comment.userName,
      directReply: params.isDirectReplyToOutstandingQuestion(issue),
      emitActivity: this.emitLinearActivity
        ? (content, options) => this.emitLinearActivity!(issue, content, options)
        : undefined,
    });
    if (result?.queuedRunType) {
      this.feed?.publish({
        level: "info",
        kind: "comment",
        projectId: project.id,
        issueKey: trackedIssue?.issueKey,
        status: "enqueued",
        summary: `Comment enqueued ${result.queuedRunType} run`,
        detail: addressedText.slice(0, 200),
      });
    }
  }
}
