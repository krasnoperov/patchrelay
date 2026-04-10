import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";

export class GitHubPrCommentHandler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly codex: { steerTurn(options: { threadId: string; turnId: string; input: string }): Promise<void> },
    private readonly feed?: OperatorEventFeed,
  ) {}

  async handleCreatedComment(payload: Record<string, unknown>): Promise<void> {
    if (payload.action !== "created") return;
    const issuePayload = payload.issue as Record<string, unknown> | undefined;
    const comment = payload.comment as Record<string, unknown> | undefined;
    if (!issuePayload || !comment) return;
    if (!issuePayload.pull_request) return;
    const body = typeof comment.body === "string" ? comment.body : "";
    if (!body.trim()) return;
    const user = comment.user as Record<string, unknown> | undefined;
    const author = typeof user?.login === "string" ? user.login : "unknown";
    if (typeof user?.type === "string" && user.type === "Bot") return;
    const prNumber = typeof issuePayload.number === "number" ? issuePayload.number : undefined;
    if (!prNumber) return;
    const issue = this.db.issues.getIssueByPrNumber(prNumber);
    if (!issue) return;

    this.feed?.publish({
      level: "info",
      kind: "comment",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: issue.factoryState,
      status: "pr_comment",
      summary: `GitHub PR comment from ${author}`,
      detail: body.slice(0, 200),
    });

    if (issue.activeRunId) {
      const run = this.db.runs.getRunById(issue.activeRunId);
      if (run?.threadId && run.turnId) {
        try {
          await this.codex.steerTurn({
            threadId: run.threadId,
            turnId: run.turnId,
            input: `GitHub PR comment from ${author}:\n\n${body}`,
          });
          this.logger.info({ issueKey: issue.issueKey, author }, "Forwarded GitHub PR comment to active run");
          return;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to forward GitHub PR comment");
        }
      }
    }

    this.db.issueSessions.appendIssueSessionEvent({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "followup_comment",
      eventJson: JSON.stringify({ body, author }),
    });
    if (this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
      this.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
  }
}
