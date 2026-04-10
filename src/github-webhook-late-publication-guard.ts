import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";

type FetchLike = typeof fetch;

function isPatchRelayBot(login: string | undefined): boolean {
  return login === "patchrelay[bot]" || login === "app/patchrelay";
}

function parseRepo(repoFullName: string): { owner: string; repo: string } | undefined {
  const [owner, repo] = repoFullName.split("/", 2);
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

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
  if (latestRun.status === "running" || latestRun.status === "completed") return false;

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
      "Late PatchRelay PR was detected after the implementation run had already stopped, but PatchRelay could not auto-close it",
    );
    feed?.publish({
      level: "warn",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: issue.factoryState,
      status: "late_pr_detected",
      summary: `Detected late PR #${event.prNumber} from an inactive implementation run`,
      detail: latestRun.failureReason ?? `Latest implementation run status: ${latestRun.status}`,
    });
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
      "Failed to auto-close late PatchRelay PR from an inactive implementation run",
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
    "Auto-closed late PatchRelay PR from an inactive implementation run",
  );
  feed?.publish({
    level: "warn",
    kind: "github",
    issueKey: issue.issueKey,
    projectId: issue.projectId,
    stage: issue.factoryState,
    status: "late_pr_closed",
    summary: `Auto-closed late PR #${event.prNumber} from an inactive implementation run`,
    detail: latestRun.failureReason ?? `Latest implementation run status: ${latestRun.status}`,
  });
  return true;
}
