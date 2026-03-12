import type { StageTurnInputStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowWebhookStoreProvider } from "./workflow-ports.ts";
import { isPatchRelayStatusComment } from "./linear-workflow.ts";
import { triggerEventAllowed } from "./project-resolution.ts";
import type { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { NormalizedEvent, ProjectConfig } from "./types.ts";

export class CommentWebhookHandler {
  constructor(
    private readonly stores: IssueWorkflowWebhookStoreProvider & StageTurnInputStoreProvider,
    private readonly turnInputDispatcher: StageTurnInputDispatcher,
  ) {}

  async handle(normalized: NormalizedEvent, project: ProjectConfig): Promise<void> {
    if ((normalized.triggerEvent !== "commentCreated" && normalized.triggerEvent !== "commentUpdated") || !normalized.comment?.body) {
      return;
    }

    if (!triggerEventAllowed(project, normalized.triggerEvent)) {
      return;
    }

    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return;
    }

    const issue = this.stores.issueWorkflows.getTrackedIssue(project.id, normalizedIssue.id);
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
    await this.turnInputDispatcher.flush(stageRun, {
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      failureMessage: "Failed to deliver queued Linear comment to active Codex turn",
    });
  }
}
