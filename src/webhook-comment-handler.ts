import type { StageEventQueryStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowWebhookStoreProvider } from "./workflow-ports.ts";
import { isPatchRelayStatusComment } from "./linear-workflow.ts";
import type { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { NormalizedEvent } from "./types.ts";

export class CommentWebhookHandler {
  constructor(
    private readonly stores: IssueWorkflowWebhookStoreProvider & StageEventQueryStoreProvider,
    private readonly turnInputDispatcher: StageTurnInputDispatcher,
  ) {}

  async handle(normalized: NormalizedEvent, projectId: string): Promise<void> {
    if ((normalized.triggerEvent !== "commentCreated" && normalized.triggerEvent !== "commentUpdated") || !normalized.comment?.body) {
      return;
    }

    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return;
    }

    const issue = this.stores.issueWorkflows.getTrackedIssue(projectId, normalizedIssue.id);
    if (!issue?.activeStageRunId) {
      return;
    }

    if (isPatchRelayStatusComment(normalized.comment.id, normalized.comment.body, issue.statusCommentId)) {
      return;
    }

    const stageRun = this.stores.issueWorkflows.getStageRun(issue.activeStageRunId);
    if (!stageRun) {
      return;
    }

    const body = [
      "New Linear comment received while you are working.",
      normalized.comment.userName ? `Author: ${normalized.comment.userName}` : undefined,
      "",
      normalized.comment.body.trim(),
    ]
      .filter(Boolean)
      .join("\n");

    this.stores.stageEvents.enqueueTurnInput({
      stageRunId: stageRun.id,
      ...(stageRun.threadId ? { threadId: stageRun.threadId } : {}),
      ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
      source: `linear-comment:${normalized.comment.id}`,
      body,
    });
    await this.turnInputDispatcher.flush(stageRun);
  }
}
