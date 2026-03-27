import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { EvictionReporter } from "../interfaces.ts";
import type { QueueEntry, IncidentRecord } from "../types.ts";
import { exec } from "../exec.ts";

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
  ) {}

  async reportEviction(entry: QueueEntry, incident: IncidentRecord): Promise<void> {
    const title = formatTitle(incident);
    const summary = formatSummary(entry, incident);
    const detailsUrl = `http://${this.serverHost}:${this.serverPort}/queue/incidents/${incident.id}`;

    const body = JSON.stringify({
      name: "merge-steward/queue",
      head_sha: entry.headSha,
      status: "completed",
      conclusion: "failure",
      details_url: detailsUrl,
      output: {
        title,
        summary,
        text: JSON.stringify(incident.context),
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
      ], { timeoutMs: 30_000 });
    } catch {
      // Best-effort — the incident record is the source of truth.
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }

    // Also try to remove the admission label (best-effort).
    await exec("gh", [
      "pr", "edit", String(entry.prNumber),
      "--repo", this.repoFullName,
      "--remove-label", "queue",
    ], { timeoutMs: 15_000 }).catch(() => {});
  }
}

function formatTitle(incident: IncidentRecord): string {
  switch (incident.failureClass) {
    case "integration_conflict":
      return "Queue eviction: rebase conflict";
    case "branch_local":
      return "Queue eviction: CI failure (branch-specific)";
    case "main_broken":
      return "Queue eviction: main branch CI failing";
    case "flaky_or_infra":
      return "Queue eviction: CI failure (possible flaky)";
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
