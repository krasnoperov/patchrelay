import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { GitHubWebhookPayload } from "./github-types.ts";
import { normalizeGitHubWebhook, verifyGitHubWebhookSignature } from "./github-webhooks.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveSecret } from "./resolve-secret.ts";
import type { AppConfig, LinearClientProvider } from "./types.ts";
import { safeJsonParse } from "./utils.ts";
import { GitHubPrCommentHandler } from "./github-pr-comment-handler.ts";
import {
  createGitHubCiSnapshotResolver,
  createGitHubFailureContextResolver,
  type GitHubCiSnapshotResolver,
  type GitHubFailureContextResolver,
} from "./github-failure-context.ts";
import { resolveGitHubWebhookIssue } from "./github-webhook-issue-resolution.ts";
import { maybeCloseLatePublishedImplementationPr } from "./github-webhook-late-publication-guard.ts";
import { projectGitHubWebhookState } from "./github-webhook-state-projector.ts";
import { maybeEnqueueGitHubReactiveRun } from "./github-webhook-reactive-run.ts";
import { handleGitHubTerminalPrEvent } from "./github-webhook-terminal-handler.ts";

type FetchLike = typeof fetch;

export class GitHubWebhookHandler {
  private readonly prCommentHandler: GitHubPrCommentHandler;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly codex: { steerTurn(options: { threadId: string; turnId: string; input: string }): Promise<void> },
    private readonly feed?: OperatorEventFeed,
    private readonly failureContextResolver: GitHubFailureContextResolver = createGitHubFailureContextResolver(),
    private readonly ciSnapshotResolver: GitHubCiSnapshotResolver = createGitHubCiSnapshotResolver(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.prCommentHandler = new GitHubPrCommentHandler(
      db,
      enqueueIssue,
      logger,
      codex,
      feed,
    );
  }

  async acceptGitHubWebhook(params: {
    deliveryId: string;
    eventType: string;
    signature: string;
    rawBody: Buffer;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    if (this.db.webhookEvents.isWebhookDuplicate(params.deliveryId)) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    const stored = this.db.webhookEvents.insertWebhookEvent(params.deliveryId, new Date().toISOString());
    const payload = safeJsonParse(params.rawBody.toString("utf8"));
    if (!payload) {
      return { status: 400, body: { ok: false, reason: "invalid_json" } };
    }

    const repoFullName = typeof payload === "object" && payload !== null && "repository" in payload
      ? (payload as Record<string, unknown>).repository
      : undefined;
    const repoName = typeof repoFullName === "object" && repoFullName !== null && "full_name" in repoFullName
      ? String((repoFullName as Record<string, string>).full_name)
      : undefined;

    const project = repoName
      ? this.config.projects.find((p) => p.github?.repoFullName === repoName)
      : undefined;

    const webhookSecret = resolveSecret("github-app-webhook-secret", "GITHUB_APP_WEBHOOK_SECRET");
    if (webhookSecret && !verifyGitHubWebhookSignature(params.rawBody, webhookSecret, params.signature)) {
      return { status: 401, body: { ok: false, reason: "invalid_signature" } };
    }

    if (stored.duplicate) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    return {
      status: 200,
      body: {
        ok: true,
        accepted: true,
        webhookEventId: stored.id,
        eventType: params.eventType,
        projectId: project?.id,
      },
    };
  }

  async processGitHubWebhookEvent(params: {
    eventType: string;
    rawBody: string;
  }): Promise<void> {
    const payload = safeJsonParse(params.rawBody);
    if (!payload || typeof payload !== "object") return;

    if (params.eventType === "push") {
      return;
    }

    if (params.eventType === "issue_comment") {
      await this.prCommentHandler.handleCreatedComment(payload as Record<string, unknown>);
      return;
    }

    const event = normalizeGitHubWebhook({
      eventType: params.eventType,
      payload: payload as GitHubWebhookPayload,
    });
    if (!event) {
      this.logger.debug({ eventType: params.eventType }, "GitHub webhook: unrecognized event type or action");
      return;
    }

    const project = this.config.projects.find((candidate) => candidate.github?.repoFullName === event.repoFullName);
    if (!project) {
      this.logger.debug({ repoFullName: event.repoFullName, triggerEvent: event.triggerEvent }, "GitHub webhook: no configured project for repository");
      return;
    }

    const resolved = resolveGitHubWebhookIssue(this.db, project, event);
    const issue = resolved?.issue;
    if (!issue) {
      this.logger.debug(
        { repoFullName: event.repoFullName, branchName: event.branchName, prNumber: event.prNumber, triggerEvent: event.triggerEvent },
        "GitHub webhook: no matching tracked issue",
      );
      return;
    }

    const suppressedLatePublication = await maybeCloseLatePublishedImplementationPr({
      db: this.db,
      logger: this.logger,
      feed: this.feed,
      issue,
      event,
      fetchImpl: this.fetchImpl,
    });
    if (suppressedLatePublication) {
      return;
    }

    const freshIssue = await projectGitHubWebhookState(
      {
        config: this.config,
        db: this.db,
        linearProvider: this.linearProvider,
        logger: this.logger,
        feed: this.feed,
        failureContextResolver: this.failureContextResolver,
        ciSnapshotResolver: this.ciSnapshotResolver,
      },
      issue,
      event,
      project,
      resolved.linkedBy,
    );

    await maybeEnqueueGitHubReactiveRun({
      db: this.db,
      logger: this.logger,
      feed: this.feed,
      enqueueIssue: this.enqueueIssue,
      issue: freshIssue,
      event,
      project,
      failureContextResolver: this.failureContextResolver,
      fetchImpl: this.fetchImpl,
    });

    if (event.triggerEvent === "pr_merged" || event.triggerEvent === "pr_closed") {
      await handleGitHubTerminalPrEvent({
        config: this.config,
        db: this.db,
        linearProvider: this.linearProvider,
        enqueueIssue: this.enqueueIssue,
        logger: this.logger,
        codex: this.codex,
        feed: this.feed,
        issue: freshIssue,
        event,
      });
    }
  }
}
