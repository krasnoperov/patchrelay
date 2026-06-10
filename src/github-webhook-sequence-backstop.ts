import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";

type FetchLike = typeof fetch;

const MAX_CACHED_FILE_SETS = 512;

/**
 * Process-lifetime caches for the backstop (core simplification plan, phase
 * C3): the operator alert is deduped per PR pair, and changed-file lists are
 * cached per head SHA so re-deliveries and multi-candidate scans don't repeat
 * the ~6 GitHub API calls per `pr_opened`.
 */
export interface SequenceBackstopCaches {
  /** `owner/repo#new->#candidate` pairs that already produced an alert. */
  alertedPrPairs: Set<string>;
  /** `owner/repo@headSha` → changed-file set observed for that head. */
  changedFilesByHead: Map<string, Set<string>>;
}

export function createSequenceBackstopCaches(): SequenceBackstopCaches {
  return { alertedPrPairs: new Set(), changedFilesByHead: new Map() };
}

const processCaches = createSequenceBackstopCaches();

// Plan §8.2: backstop for missed sequence-checks. When a PR is
// opened and its changed-file set overlaps with another in-flight
// PR's, surface an operator event so the agent can be re-prompted
// (or a human can intervene). The full merge-tree probe lives in
// the CLI command; the backstop is intentionally cheap — file-set
// overlap only — because the webhook handler has no worktree.
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
  if (!event.repoFullName || event.prNumber === undefined) return;

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) return;

  const [owner, repo] = event.repoFullName.split("/", 2);
  if (!owner || !repo) return;

  const newPrFiles = await listChangedFilesCached({
    caches,
    fetchImpl,
    token,
    owner,
    repo,
    prNumber: event.prNumber,
    headSha: event.headSha,
  });
  if (!newPrFiles || newPrFiles.size === 0) return;

  const candidates = db.issues
    .listIssues()
    .filter(
      (issue) =>
        (issue.factoryState === "pr_open" || issue.factoryState === "awaiting_queue")
        && issue.prNumber !== undefined
        && issue.prNumber !== event.prNumber
        && issue.branchName !== undefined
        && issue.branchName !== event.branchName,
    );

  for (const candidate of candidates) {
    const pairKey = `${owner}/${repo}#${event.prNumber}->#${candidate.prNumber}`;
    if (caches.alertedPrPairs.has(pairKey)) continue;
    const candidateFiles = await listChangedFilesCached({
      caches,
      fetchImpl,
      token,
      owner,
      repo,
      prNumber: candidate.prNumber!,
      headSha: candidate.prHeadSha,
    });
    if (!candidateFiles) continue;
    const overlap = intersect(newPrFiles, candidateFiles);
    if (overlap.length === 0) continue;

    caches.alertedPrPairs.add(pairKey);
    logger.info(
      {
        event: "sequence_backstop_overlap_detected",
        prNumber: event.prNumber,
        candidatePrNumber: candidate.prNumber,
        overlap: overlap.slice(0, 10),
      },
      "potential stack-target detected on pr_opened",
    );
    feed?.publish({
      level: "warn",
      kind: "github",
      summary: `PR #${event.prNumber} may need to stack on PR #${candidate.prNumber} (overlapping files)`,
      detail: `Overlapping files: ${overlap.slice(0, 5).join(", ")}${overlap.length > 5 ? "…" : ""}`,
      ...(candidate.issueKey ? { issueKey: candidate.issueKey } : {}),
      ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
    });
    // First overlap is enough — the operator-facing signal does not
    // need to enumerate every potential parent.
    return;
  }
}

async function listChangedFilesCached(params: {
  caches: SequenceBackstopCaches;
  fetchImpl: FetchLike;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string | undefined;
}): Promise<Set<string> | undefined> {
  const { caches } = params;
  const cacheKey = params.headSha ? `${params.owner}/${params.repo}@${params.headSha}` : undefined;
  if (cacheKey) {
    const cached = caches.changedFilesByHead.get(cacheKey);
    if (cached) return cached;
  }
  const files = await listChangedFiles(
    params.fetchImpl,
    params.token,
    params.owner,
    params.repo,
    params.prNumber,
  ).catch(() => undefined);
  if (cacheKey && files) {
    if (caches.changedFilesByHead.size >= MAX_CACHED_FILE_SETS) {
      caches.changedFilesByHead.clear();
    }
    caches.changedFilesByHead.set(cacheKey, files);
  }
  return files;
}

async function listChangedFiles(
  fetchImpl: FetchLike,
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Set<string> | undefined> {
  const result = new Set<string>();
  let page = 1;
  // GitHub caps `pulls/{n}/files` at 3000 across pages of 100.
  while (page <= 30) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "patchrelay",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) return undefined;
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return undefined;
    for (const entry of payload) {
      if (!entry || typeof entry !== "object") continue;
      const filename = (entry as { filename?: unknown }).filename;
      if (typeof filename === "string" && filename) result.add(filename);
    }
    if (payload.length < 100) break;
    page += 1;
  }
  return result;
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const result: string[] = [];
  for (const value of a) {
    if (b.has(value)) result.push(value);
  }
  return result;
}
