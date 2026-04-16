import { loadConfig } from "../config.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import type { ReviewQuillWatchSnapshot, ReviewQuillRepoSummary } from "../types.ts";
import { clusterSummaryText, getRepoHealth, getReviewQueueText, projectStatsSummary } from "../watch/dashboard-model.ts";
import { relativeTime, runtimeLabel } from "../watch/format.ts";
import { fetchSnapshot } from "../watch/api.ts";
import type { ParsedArgs } from "./args.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";

function resolveBaseUrl(configPath: string): string {
  const config = loadConfig(configPath);
  const bind = config.server.bind === "0.0.0.0" ? "127.0.0.1"
    : config.server.bind === "::" ? "[::1]"
    : config.server.bind.includes(":") && !config.server.bind.startsWith("[") ? `[${config.server.bind}]`
    : config.server.bind;
  return `http://${bind}:${config.server.port}`;
}

function repoSnapshotLine(snapshot: ReviewQuillWatchSnapshot, repo: ReviewQuillRepoSummary): string {
  const health = getRepoHealth(snapshot, repo);
  const queueText = getReviewQueueText(snapshot, repo, true);
  const summary = projectStatsSummary(snapshot, repo, true);
  const detail = queueText === "idle" ? "idle" : queueText;
  return `${repo.repoId.padEnd(12)} ${health.label.toLowerCase()} ${summary}  ${detail}`;
}

export async function handleStatus(configPath: string | undefined, parsed: ParsedArgs, stdout: Output): Promise<number> {
  const resolvedConfigPath = configPath ?? getDefaultConfigPath();
  const baseUrl = resolveBaseUrl(resolvedConfigPath);
  const snapshot = await fetchSnapshot(baseUrl);
  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(snapshot));
    return 0;
  }

  const header = [
    `review-quill`,
    `${snapshot.summary.runningAttempts}a`,
    `${snapshot.summary.queuedAttempts}q`,
    `${snapshot.summary.failedAttempts}f`,
    `runner ${runtimeLabel(snapshot.runtime)}`,
    snapshot.runtime.lastReconcileCompletedAt || snapshot.runtime.lastReconcileStartedAt
      ? `last ${relativeTime(snapshot.runtime.lastReconcileCompletedAt ?? snapshot.runtime.lastReconcileStartedAt)}`
      : "last never",
    "fresh 0s",
  ].filter(Boolean).join(" | ");

  const lines = [
    header,
    "",
    "Review Overview",
    clusterSummaryText(snapshot),
    "",
    ...snapshot.repos.map((repo) => `  ${repoSnapshotLine(snapshot, repo)}`),
  ];
  writeOutput(stdout, `${lines.join("\n")}\n`);
  return 0;
}
