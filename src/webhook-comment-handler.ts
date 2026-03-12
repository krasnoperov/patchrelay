import { createHash } from "node:crypto";
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
    const activeRunLeaseId = this.stores.issueControl?.getIssueControl(project.id, normalizedIssue.id)?.activeRunLeaseId;
    const dedupeKey = buildCommentDedupeKey(normalized.comment.id, body);
    if (
      activeRunLeaseId !== undefined &&
      this.stores.obligations?.getObligationByDedupeKey({
        runLeaseId: activeRunLeaseId,
        kind: "deliver_turn_input",
        dedupeKey,
      })
    ) {
      return;
    }

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
      dedupeKey,
    );
    await this.turnInputDispatcher.flush(stageRun, {
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      failureMessage: "Failed to deliver queued Linear comment to active Codex turn",
    });
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
    dedupeKey: string,
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
      dedupeKey,
    });
    return obligation.id;
  }
}

function buildCommentDedupeKey(commentId: string, body: string): string {
  return `linear-comment:${commentId}:${hashBody(body)}`;
}

function hashBody(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
