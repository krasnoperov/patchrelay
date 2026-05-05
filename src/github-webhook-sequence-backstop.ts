import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";

type FetchLike = typeof fetch;

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
}): Promise<void> {
  const { db, logger, feed, event } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  if (event.triggerEvent !== "pr_opened") return;
  if (!event.repoFullName || event.prNumber === undefined) return;

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) return;

  const [owner, repo] = event.repoFullName.split("/", 2);
  if (!owner || !repo) return;

  const newPrFiles = await listChangedFiles(fetchImpl, token, owner, repo, event.prNumber).catch(
    () => undefined,
  );
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
    const candidateFiles = await listChangedFiles(
      fetchImpl,
      token,
      owner,
      repo,
      candidate.prNumber!,
    ).catch(() => undefined);
    if (!candidateFiles) continue;
    const overlap = intersect(newPrFiles, candidateFiles);
    if (overlap.length === 0) continue;

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
