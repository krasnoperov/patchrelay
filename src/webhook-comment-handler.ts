import { createHash } from "node:crypto";
import type { IssueControlStoreProvider, ObligationStoreProvider, RunLeaseStoreProvider } from "./ledger-ports.ts";
import type { IssueWorkflowQueryStoreProvider } from "./workflow-ports.ts";
import { isPatchRelayStatusComment } from "./linear-workflow.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { triggerEventAllowed } from "./project-resolution.ts";
import type { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { NormalizedEvent, ProjectConfig, WorkflowStage } from "./types.ts";

export class CommentWebhookHandler {
  constructor(
    private readonly stores: IssueWorkflowQueryStoreProvider &
      IssueControlStoreProvider &
      ObligationStoreProvider &
      RunLeaseStoreProvider,
    private readonly turnInputDispatcher: StageTurnInputDispatcher,
    private readonly feed?: OperatorEventFeed,
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
    const issueControl = this.stores.issueControl.getIssueControl(project.id, normalizedIssue.id);
    if (!issueControl?.activeRunLeaseId) {
      return;
    }

    if (isPatchRelayStatusComment(normalized.comment.id, normalized.comment.body, issueControl.serviceOwnedCommentId ?? issue?.statusCommentId)) {
      return;
    }

    const runLease = this.stores.runLeases.getRunLease(issueControl.activeRunLeaseId);
    if (!runLease) {
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
    const dedupeKey = buildCommentDedupeKey(normalized.comment.id, body);
    if (
      issueControl.activeRunLeaseId !== undefined &&
        this.stores.obligations.getObligationByDedupeKey({
        runLeaseId: issueControl.activeRunLeaseId,
        kind: "deliver_turn_input",
        dedupeKey,
      })
    ) {
      return;
    }

    const obligationId = this.enqueueObligation(
      project.id,
      normalizedIssue.id,
      runLease.threadId,
      runLease.turnId,
      normalized.comment.id,
      body,
      dedupeKey,
    );
    const flushResult = await this.turnInputDispatcher.flush(
      {
        id: issueControl.activeRunLeaseId,
        projectId: project.id,
        linearIssueId: normalizedIssue.id,
        ...(runLease.threadId ? { threadId: runLease.threadId } : {}),
        ...(runLease.turnId ? { turnId: runLease.turnId } : {}),
      },
      {
        ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
        failureMessage: "Failed to deliver queued Linear comment to active Codex turn",
      },
    );
    this.publishCommentDeliveryEvent({
      projectId: project.id,
      issueKey: issue?.issueKey ?? normalizedIssue.identifier,
      stage: runLease.stage,
      obligationId,
      authorName: normalized.comment.userName,
      flushResult,
    });
  }

  private enqueueObligation(
    projectId: string,
    linearIssueId: string,
    threadId: string | undefined,
    turnId: string | undefined,
    commentId: string,
    body: string,
    dedupeKey: string,
  ): number | undefined {
    const activeRunLeaseId = this.stores.issueControl.getIssueControl(projectId, linearIssueId)?.activeRunLeaseId;
    if (activeRunLeaseId === undefined) {
      return undefined;
    }

    const obligation = this.stores.obligations.enqueueObligation({
      projectId,
      linearIssueId,
      kind: "deliver_turn_input",
      source: `linear-comment:${commentId}`,
      payloadJson: JSON.stringify({
        body,
      }),
      runLeaseId: activeRunLeaseId,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      dedupeKey,
    });
    return obligation.id;
  }

  private publishCommentDeliveryEvent(params: {
    projectId: string;
    issueKey?: string;
    stage: WorkflowStage;
    obligationId: number | undefined;
    authorName?: string;
    flushResult: {
      deliveredObligationIds: number[];
      failedObligationIds: number[];
    };
  }): void {
    if (params.obligationId === undefined) {
      return;
    }

    const authorDetail = params.authorName ? `Author: ${params.authorName}.` : undefined;
    if (params.flushResult.deliveredObligationIds.includes(params.obligationId)) {
      this.feed?.publish({
        level: "info",
        kind: "comment",
        projectId: params.projectId,
        issueKey: params.issueKey,
        stage: params.stage,
        status: "delivered",
        summary: `Delivered follow-up comment to active ${params.stage} workflow`,
        detail: authorDetail ?? "The comment was routed into the running Codex turn.",
      });
      return;
    }

    if (params.flushResult.failedObligationIds.includes(params.obligationId)) {
      this.feed?.publish({
        level: "warn",
        kind: "comment",
        projectId: params.projectId,
        issueKey: params.issueKey,
        stage: params.stage,
        status: "delivery_failed",
        summary: `Could not deliver follow-up comment to active ${params.stage} workflow`,
        detail: authorDetail ?? "PatchRelay kept the comment queued and will retry delivery.",
      });
      return;
    }

    this.feed?.publish({
      level: "info",
      kind: "comment",
      projectId: params.projectId,
      issueKey: params.issueKey,
      stage: params.stage,
      status: "queued",
      summary: `Queued follow-up comment for active ${params.stage} workflow`,
      detail: authorDetail ?? "PatchRelay saved the comment for the next delivery opportunity.",
    });
  }
}

function buildCommentDedupeKey(commentId: string, body: string): string {
  return `linear-comment:${commentId}:${hashBody(body)}`;
}

function hashBody(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
