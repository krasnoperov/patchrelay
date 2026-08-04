import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { isIssuePublishedOrDownstreamProjection } from "./issue-execution-state.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";

type FetchLike = typeof fetch;

export interface SequenceBackstopCaches {
  /** `owner/repo#new->#candidate` pairs that already produced an alert. */
  alertedPrPairs: Set<string>;
  /** Exact GitHub result for immutable heads plus the declared base ref. */
  ancestryByHeadPair: Map<string, boolean>;
}

export function createSequenceBackstopCaches(): SequenceBackstopCaches {
  return { alertedPrPairs: new Set(), ancestryByHeadPair: new Map() };
}

const processCaches = createSequenceBackstopCaches();

/**
 * Backstop for an agent that skipped the local sequence check. File overlap is
 * intentionally irrelevant: independent PRs may touch the same files. Alert
 * only when the newly opened PR shares history with another open PR that is
 * absent from its declared base.
 */
export async function maybeRunSequenceBackstop(params: {
  db: PatchRelayDatabase;
  logger: Logger;
  feed?: OperatorEventFeed;
  event: NormalizedGitHubEvent;
  fetchImpl?: FetchLike;
  caches?: SequenceBackstopCaches;
}): Promise<void> {
  const { db, logger, feed, event } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  const caches = params.caches ?? processCaches;
  if (event.triggerEvent !== "pr_opened") return;
  if (!event.repoFullName || event.prNumber === undefined || !event.headSha) return;

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) return;

  const [owner, repo] = event.repoFullName.split("/", 2);
  if (!owner || !repo) return;

  const openedIssue = db.issues.listIssues().find(
    (issue) => issue.projectId === event.repoFullName && issue.prNumber === event.prNumber,
  );
  const candidates = db.issues
    .listIssues()
    .filter(
      (issue) =>
        issue.projectId === event.repoFullName
        && isIssuePublishedOrDownstreamProjection(issue)
        && issue.prNumber !== undefined
        && issue.prNumber !== event.prNumber
        && issue.branchName !== undefined
        && issue.branchName !== event.branchName
        && issue.prHeadSha !== undefined,
    );

  for (const candidate of candidates) {
    const pairKey = `${owner}/${repo}#${event.prNumber}->#${candidate.prNumber}`;
    if (caches.alertedPrPairs.has(pairKey)) continue;

    const baseRef = event.prBaseRef ?? "main";
    const headPairKey = `${owner}/${repo}@${candidate.prHeadSha}...${event.headSha}@${baseRef}`;
    let sharesUnlandedHistory = caches.ancestryByHeadPair.get(headPairKey);
    if (sharesUnlandedHistory === undefined) {
      sharesUnlandedHistory = await compareSharedAncestry({
        fetchImpl,
        token,
        owner,
        repo,
        ancestorHead: candidate.prHeadSha!,
        descendantHead: event.headSha,
        baseRef,
      });
      if (sharesUnlandedHistory === undefined) continue;
      caches.ancestryByHeadPair.set(headPairKey, sharesUnlandedHistory);
    }
    if (!sharesUnlandedHistory) continue;

    caches.alertedPrPairs.add(pairKey);
    logger.warn(
      {
        event: "open_pr_ancestry_detected",
        prNumber: event.prNumber,
        blockingPrNumber: candidate.prNumber,
        blockingHeadSha: candidate.prHeadSha,
      },
      "new PR shares unlanded history with another open PR",
    );
    feed?.publish({
      level: "warn",
      kind: "github",
      summary: `PR #${event.prNumber} shares unlanded history with open PR #${candidate.prNumber} and must be rebuilt on the default branch`,
      detail: `Other open PR head: ${candidate.prHeadSha}`,
      ...(openedIssue?.issueKey ? { issueKey: openedIssue.issueKey } : {}),
      ...(openedIssue?.projectId ? { projectId: openedIssue.projectId } : {}),
    });
  }
}

async function compareSharedAncestry(params: {
  fetchImpl: FetchLike;
  token: string;
  owner: string;
  repo: string;
  ancestorHead: string;
  descendantHead: string;
  baseRef: string;
}): Promise<boolean | undefined> {
  const sharedResponse = await params.fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/compare/${encodeURIComponent(params.ancestorHead)}...${encodeURIComponent(params.descendantHead)}`,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "patchrelay",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!sharedResponse.ok) return undefined;
  const sharedPayload = await sharedResponse.json() as {
    status?: unknown;
    merge_base_commit?: { sha?: unknown };
  };
  if (sharedPayload.status === "behind") return false;
  const sharedAncestorSha = sharedPayload.merge_base_commit?.sha;
  if (typeof sharedAncestorSha !== "string" || !sharedAncestorSha) return undefined;

  const baseResponse = await params.fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/compare/${encodeURIComponent(sharedAncestorSha)}...${encodeURIComponent(params.baseRef)}`,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "patchrelay",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!baseResponse.ok) return undefined;
  const basePayload = await baseResponse.json() as { status?: unknown };
  return basePayload.status !== "ahead" && basePayload.status !== "identical";
}
