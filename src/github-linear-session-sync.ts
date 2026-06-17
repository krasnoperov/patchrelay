import type { Logger } from "pino";
import type { IssueRecord } from "./db-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import { buildAgentSessionPlanForIssue } from "./agent-session-plan.ts";
import { buildGitHubStateActivity } from "./linear-session-reporting.ts";
import type { AppConfig, LinearClientProvider } from "./types.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { sharedLinearWriteBackoff } from "./linear-rate-limit.ts";

export async function emitGitHubLinearActivity(params: {
  linearProvider: LinearClientProvider;
  logger: Logger;
  feed: OperatorEventFeed | undefined;
  issue: IssueRecord;
  newState: string;
  event: NormalizedGitHubEvent;
}): Promise<void> {
  const { issue, newState, event, linearProvider, logger, feed } = params;
  if (!issue.agentSessionId) return;
  if (!sharedLinearWriteBackoff.shouldAttempt(issue.projectId)) {
    logger.debug({ issueKey: issue.issueKey, newState }, "Skipping GitHub Linear activity during rate-limit backoff");
    return;
  }
  try {
    const linear = await linearProvider.forProject(issue.projectId);
    if (!linear?.createAgentActivity) return;
    const content = buildGitHubStateActivity(issue.factoryState, event);
    if (!content) return;
    const allowEphemeral = content.type === "thought" || content.type === "action";
    await linear.createAgentActivity({
      agentSessionId: issue.agentSessionId,
      content,
      ...(allowEphemeral ? { ephemeral: false } : {}),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sharedLinearWriteBackoff.noteError(issue.projectId, error);
    logger.warn({ issueKey: issue.issueKey, newState, error: msg }, "Failed to emit Linear activity from GitHub webhook");
    feed?.publish({
      level: "warn",
      kind: "linear",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      status: "linear_error",
      summary: `Linear activity failed: ${msg}`,
    });
  }
}

export async function syncGitHubLinearSession(params: {
  config: AppConfig;
  linearProvider: LinearClientProvider;
  logger: Logger;
  issue: IssueRecord;
}): Promise<void> {
  const { issue, linearProvider, logger, config } = params;
  if (!issue.agentSessionId) return;
  if (!sharedLinearWriteBackoff.shouldAttempt(issue.projectId)) {
    logger.debug({ issueKey: issue.issueKey }, "Skipping GitHub Linear session sync during rate-limit backoff");
    return;
  }
  try {
    const linear = await linearProvider.forProject(issue.projectId);
    if (!linear?.updateAgentSession) return;
    const externalUrls = buildAgentSessionExternalUrls(config, {
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      ...(issue.prUrl ? { prUrl: issue.prUrl } : {}),
      ...(issue.activeRunId !== undefined ? { activeRunId: issue.activeRunId } : {}),
      ...(issue.prReviewState ? { prReviewState: issue.prReviewState } : {}),
      ...(issue.prCheckStatus ? { prCheckStatus: issue.prCheckStatus } : {}),
      ...(issue.lastGitHubFailureSource ? { lastGitHubFailureSource: issue.lastGitHubFailureSource } : {}),
      ...(issue.lastGitHubFailureCheckName ? { lastGitHubFailureCheckName: issue.lastGitHubFailureCheckName } : {}),
      ...(issue.lastGitHubFailureCheckUrl ? { lastGitHubFailureCheckUrl: issue.lastGitHubFailureCheckUrl } : {}),
      ...(issue.lastQueueIncidentJson ? { lastQueueIncidentJson: issue.lastQueueIncidentJson } : {}),
    });
    await linear.updateAgentSession({
      agentSessionId: issue.agentSessionId,
      plan: buildAgentSessionPlanForIssue(issue),
      ...(externalUrls ? { externalUrls } : {}),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sharedLinearWriteBackoff.noteError(issue.projectId, error);
    logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to sync Linear session from GitHub webhook");
  }
}
