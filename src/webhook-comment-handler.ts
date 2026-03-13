import { createHash } from "node:crypto";
import type { IssueControlStoreProvider, ObligationStoreProvider, RunLeaseStoreProvider } from "./ledger-ports.ts";
import type { IssueWorkflowQueryStoreProvider } from "./workflow-ports.ts";
import { isPatchRelayStatusComment } from "./linear-workflow.ts";
import { triggerEventAllowed } from "./project-resolution.ts";
import type { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { NormalizedEvent, ProjectConfig } from "./types.ts";

export class CommentWebhookHandler {
  constructor(
    private readonly stores: IssueWorkflowQueryStoreProvider &
      IssueControlStoreProvider &
      ObligationStoreProvider &
      RunLeaseStoreProvider,
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

    this.enqueueObligation(
      project.id,
      normalizedIssue.id,
      runLease.threadId,
      runLease.turnId,
      normalized.comment.id,
      body,
      dedupeKey,
    );
    await this.turnInputDispatcher.flush(
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
}

function buildCommentDedupeKey(commentId: string, body: string): string {
  return `linear-comment:${commentId}:${hashBody(body)}`;
}

function hashBody(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
