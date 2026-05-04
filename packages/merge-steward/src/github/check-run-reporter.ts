import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { EvictionReporter } from "../interfaces.ts";
import type { QueueEntry, IncidentRecord } from "../types.ts";
import { exec } from "../exec.ts";
import { DEFAULT_MERGE_QUEUE_CHECK_NAME } from "../config.ts";

// Plan §5.2 default — review-quill subscribes by default; configurable
// per project via the bus contract added in PR 1.
const DEFAULT_SPEC_READY_CHECK_NAME = "merge-steward/spec-ready";

/**
 * Reports evictions by creating a GitHub check run on the PR's head SHA.
 * The check run output contains the incident context as structured JSON.
 * The incident record is the source of truth; the check run is a projection.
 */
export class GitHubCheckRunReporter implements EvictionReporter {
  constructor(
    private readonly repoFullName: string,
    private readonly serverHost: string,
    private readonly serverPort: number,
    private readonly publicBaseUrl?: string,
    private readonly admissionLabel: string = "queue",
    private readonly mergeQueueCheckName: string = DEFAULT_MERGE_QUEUE_CHECK_NAME,
    private readonly specReadyCheckName: string = DEFAULT_SPEC_READY_CHECK_NAME,
  ) {}

  async reportEviction(entry: QueueEntry, incident: IncidentRecord): Promise<void> {
    const title = formatTitle(incident);
    const summary = formatSummary(entry, incident);
    const detailsUrl = this.publicBaseUrl
      ? new URL(`/queue/incidents/${incident.id}`, this.publicBaseUrl).toString()
      : `http://${this.serverHost}:${this.serverPort}/queue/incidents/${incident.id}`;

    const body = JSON.stringify({
      name: this.mergeQueueCheckName,
      head_sha: entry.headSha,
      status: "completed",
      conclusion: "failure",
      details_url: detailsUrl,
      output: {
        title,
        summary,
        text: JSON.stringify(buildIncidentProjection(incident, detailsUrl)),
      },
    });

    // gh api --input requires a file path (execFile can't pipe stdin).
    // Write to temp file, pass path, clean up.
    const tmpPath = join(tmpdir(), `steward-checkrun-${randomUUID()}.json`);
    try {
      writeFileSync(tmpPath, body);
      await exec("gh", [
        "api",
        `repos/${this.repoFullName}/check-runs`,
        "--method", "POST",
        "--input", tmpPath,
      ], { timeoutMs: 30_000, githubRepoFullName: this.repoFullName });
    } catch {
      // Best-effort — the incident record is the source of truth.
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }

    // Also try to remove the admission label (best-effort).
    await exec("gh", [
      "pr", "edit", String(entry.prNumber),
      "--repo", this.repoFullName,
      "--remove-label", this.admissionLabel,
    ], { timeoutMs: 15_000, githubRepoFullName: this.repoFullName }).catch(() => {});
  }

  // Plan §5.2: a "spec is ready" event on the PR head — not a verdict.
  // Conclusion is `neutral` so branch-protection rules treat it as a
  // signal rather than a gate. Best-effort: failures are logged in the
  // exec layer and not propagated.
  async reportSpecReady(entry: QueueEntry, specBranch: string, specSha: string): Promise<void> {
    const targetUrl = `https://github.com/${this.repoFullName}/commit/${specSha}`;
    const summary = [
      `Spec branch \`${specBranch}\` is at \`${specSha.slice(0, 12)}\`.`,
      ``,
      `This is the integration tree the lander will run CI on. Reviewers`,
      `subscribed to integration_tree mode use this commit as the head`,
      `they review.`,
    ].join("\n");

    const body = JSON.stringify({
      name: this.specReadyCheckName,
      head_sha: entry.headSha,
      status: "completed",
      conclusion: "neutral",
      details_url: targetUrl,
      output: {
        title: `Spec ready (${specBranch})`,
        summary,
        text: JSON.stringify({ specBranch, specSha, prNumber: entry.prNumber, queueEntryId: entry.id }),
      },
    });

    const tmpPath = join(tmpdir(), `steward-specready-${randomUUID()}.json`);
    try {
      writeFileSync(tmpPath, body);
      await exec("gh", [
        "api",
        `repos/${this.repoFullName}/check-runs`,
        "--method", "POST",
        "--input", tmpPath,
      ], { timeoutMs: 30_000, githubRepoFullName: this.repoFullName });
    } catch {
      // Best-effort — review-quill can also fall back to polling the
      // spec branch directly if it never sees this check_run.
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }
  }
}

function buildIncidentProjection(incident: IncidentRecord, detailsUrl: string): Record<string, unknown> {
  return {
    incidentId: incident.id,
    incidentAt: incident.at,
    incidentUrl: detailsUrl,
    ...incident.context,
  };
}

function formatTitle(incident: IncidentRecord): string {
  switch (incident.failureClass) {
    case "integration_conflict":
      return "Queue eviction: rebase conflict";
    case "branch_local":
      return "Queue eviction: CI failure (branch-specific)";
    case "main_broken":
      return "Queue eviction: main branch CI failing";
    case "policy_blocked":
      return "Queue eviction: approval withdrawn";
    default:
      return "Queue eviction";
  }
}

function formatSummary(entry: QueueEntry, incident: IncidentRecord): string {
  const lines = [
    `PR #${entry.prNumber} was evicted from the merge queue.`,
    ``,
    `**Failure class:** ${incident.failureClass}`,
    `**Base SHA:** ${incident.context.baseSha}`,
    `**PR HEAD:** ${incident.context.prHeadSha}`,
    `**Queue position:** ${incident.context.queuePosition}`,
  ];

  if (incident.context.conflictFiles?.length) {
    lines.push(``, `**Conflicting files:**`);
    for (const f of incident.context.conflictFiles) {
      lines.push(`- ${f}`);
    }
  }

  if (incident.context.failedChecks?.length) {
    lines.push(``, `**Failed checks:**`);
    for (const c of incident.context.failedChecks) {
      lines.push(`- ${c.name} (${c.conclusion})`);
    }
  }

  lines.push(``, `**Incident ID:** ${incident.id}`);
  return lines.join("\n");
}
