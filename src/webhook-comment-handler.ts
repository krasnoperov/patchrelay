import type { IssueControlStoreProvider, ObligationStoreProvider } from "./ledger-ports.ts";
import type { StageTurnInputStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowWebhookStoreProvider } from "./workflow-ports.ts";
import { isPatchRelayStatusComment } from "./linear-workflow.ts";
import { triggerEventAllowed } from "./project-resolution.ts";
import type { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { NormalizedEvent, ProjectConfig } from "./types.ts";

export class CommentWebhookHandler {
  constructor(
    private readonly stores: IssueWorkflowWebhookStoreProvider &
      StageTurnInputStoreProvider &
      Partial<IssueControlStoreProvider & ObligationStoreProvider>,
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

    const source = `linear-comment:${normalized.comment.id}`;
    const queuedInputId = this.stores.stageEvents.enqueueTurnInput({
      stageRunId: stageRun.id,
      ...(stageRun.threadId ? { threadId: stageRun.threadId } : {}),
      ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
      source,
      body,
    });
    const obligationId = this.enqueueObligation(
      project.id,
      normalizedIssue.id,
      stageRun.id,
      stageRun.threadId,
      stageRun.turnId,
      queuedInputId,
      normalized.comment.id,
      body,
    );
    await this.turnInputDispatcher.flush(stageRun, {
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      failureMessage: "Failed to deliver queued Linear comment to active Codex turn",
    });

    if (!obligationId) {
      return;
    }

    const stillPending = this.stores.stageEvents.listPendingTurnInputs(stageRun.id).some((input) => input.id === queuedInputId);
    if (!stillPending) {
      this.stores.obligations?.markObligationStatus(obligationId, "completed");
    }
  }

  private enqueueObligation(
    projectId: string,
    linearIssueId: string,
    stageRunId: number,
    threadId: string | undefined,
    turnId: string | undefined,
    queuedInputId: number,
    commentId: string,
    body: string,
  ): number | undefined {
    const activeRunLeaseId = this.stores.issueControl?.getIssueControl(projectId, linearIssueId)?.activeRunLeaseId;
    if (!this.stores.obligations || activeRunLeaseId === undefined) {
      return undefined;
    }

    const obligation = this.stores.obligations.enqueueObligation({
      projectId,
      linearIssueId,
      kind: "deliver_turn_input",
      source: `linear-comment:${commentId}`,
      payloadJson: JSON.stringify({
        queuedInputId,
        stageRunId,
        body,
      }),
      runLeaseId: activeRunLeaseId,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      dedupeKey: `linear-comment:${commentId}`,
    });
    return obligation.id;
  }
}
