import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { isTerminalRunStatus } from "./run-settlement.ts";

type FetchLike = typeof fetch;

function isPatchRelayBot(login: string | undefined): boolean {
  return login === "patchrelay[bot]" || login === "app/patchrelay";
}

function parseRepo(repoFullName: string): { owner: string; repo: string } | undefined {
  const [owner, repo] = repoFullName.split("/", 2);
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

/**
 * Late-publication guard (core simplification plan, phase C3).
 *
 * Detects a PatchRelay-authored `pr_opened` for an issue with no recorded PR
 * while the latest implementation run is already settled — settleRun owns
 * settlement, so a terminal run can no longer claim this PR as its own
 * publication. Every such PR gets an operator-feed alert.
 *
 * Autonomous action is limited to one case: a run with status `released`,
 * which PatchRelay itself stopped before publication (issue blocked,
 * undelegated, or superseded mid-implementation) — its PR is unwanted by
 * construction and is auto-closed. For any other settled status (`completed`,
 * `failed`, `superseded`) the run may have legitimately published right at
 * the end (the webhook can race settlement), so the PR is linked normally
 * and the operator decides.
 *
 * Returns `true` when the PR was suppressed (closed) and the webhook should
 * not be projected onto the issue.
 */
export async function maybeCloseLatePublishedImplementationPr(params: {
  db: PatchRelayDatabase;
  logger: Logger;
  feed: OperatorEventFeed | undefined;
  issue: IssueRecord;
  event: NormalizedGitHubEvent;
  fetchImpl: FetchLike;
}): Promise<boolean> {
  const { db, logger, feed, issue, event, fetchImpl } = params;

  if (event.triggerEvent !== "pr_opened") return false;
  if (event.prNumber === undefined) return false;
  if (issue.prNumber !== undefined) return false;
  if (!isPatchRelayBot(event.prAuthorLogin)) return false;

  const latestRun = db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
  if (!latestRun || latestRun.runType !== "implementation") return false;
  // A non-terminal run (queued/running) is still allowed to publish — this
  // is the normal mid-run PR creation path.
  if (!isTerminalRunStatus(latestRun.status)) return false;

  // Detection: the implementation run is settled, yet a bot PR just arrived.
  logger.warn(
    {
      issueKey: issue.issueKey,
      prNumber: event.prNumber,
      latestRunId: latestRun.id,
      latestRunStatus: latestRun.status,
    },
    "Late PatchRelay PR detected after the implementation run was settled",
  );
  feed?.publish({
    level: "warn",
    kind: "github",
    issueKey: issue.issueKey,
    projectId: issue.projectId,
    stage: issue.factoryState,
    status: "late_pr_detected",
    summary: `Detected late PR #${event.prNumber} from a settled implementation run (${latestRun.status})`,
    detail: latestRun.failureReason ?? `Latest implementation run status: ${latestRun.status}`,
  });

  if (latestRun.status !== "released") {
    // The run may have published legitimately just before settling; link the
    // PR and leave the decision to the operator.
    return false;
  }

  const repo = parseRepo(event.repoFullName);
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!repo || !token) {
    logger.warn(
      {
        issueKey: issue.issueKey,
        prNumber: event.prNumber,
        latestRunId: latestRun.id,
        latestRunStatus: latestRun.status,
      },
      "Late PatchRelay PR from a released implementation run could not be auto-closed (missing repo or token)",
    );
    return false;
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${event.prNumber}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "patchrelay",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ state: "closed" }),
    },
  );

  if (!response.ok) {
    logger.warn(
      {
        issueKey: issue.issueKey,
        prNumber: event.prNumber,
        status: response.status,
        latestRunId: latestRun.id,
        latestRunStatus: latestRun.status,
      },
      "Failed to auto-close late PatchRelay PR from a released implementation run",
    );
    feed?.publish({
      level: "warn",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: issue.factoryState,
      status: "late_pr_close_failed",
      summary: `Could not auto-close late PR #${event.prNumber}`,
      detail: latestRun.failureReason ?? `Latest implementation run status: ${latestRun.status}`,
    });
    return false;
  }

  logger.warn(
    {
      issueKey: issue.issueKey,
      prNumber: event.prNumber,
      latestRunId: latestRun.id,
      latestRunStatus: latestRun.status,
    },
    "Auto-closed late PatchRelay PR from a released implementation run",
  );
  feed?.publish({
    level: "warn",
    kind: "github",
    issueKey: issue.issueKey,
    projectId: issue.projectId,
    stage: issue.factoryState,
    status: "late_pr_closed",
    summary: `Auto-closed late PR #${event.prNumber} from a released implementation run`,
    detail: latestRun.failureReason ?? `Latest implementation run status: ${latestRun.status}`,
  });
  return true;
}
