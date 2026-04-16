import { decorateAttempt } from "../attempt-state.ts";
import { loadConfig } from "../config.ts";
import { SqliteStore } from "../db/sqlite-store.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import { loadRepoConfigById } from "../cli-system.ts";
import type { ReviewAttemptRecord } from "../types.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";
import { type ParsedArgs } from "./args.ts";
import { resolvePrNumber, resolveRepo, type ResolveCommandRunner } from "./resolve.ts";
import { parseIntegerFlag } from "./args.ts";

export type PrReviewKind =
  | "approved"
  | "skipped"
  | "declined"
  | "errored"
  | "queued"
  | "running"
  | "cancelled"
  | "no_attempt";

export interface PrReviewReport {
  repoId: string;
  repoFullName: string;
  prNumber: number;
  kind: PrReviewKind;
  terminal: boolean;
  exitCode: number;
  attempt?: ReviewAttemptRecord & { stale?: boolean; staleReason?: string };
  summaryFirstLine?: string;
  checkedAt: string;
  reason?: string;
}

export function classifyAttempt(attempt: ReviewAttemptRecord | undefined): { kind: PrReviewKind; reason?: string } {
  if (!attempt) return { kind: "no_attempt", reason: "No review attempt has been recorded for this PR head." };
  switch (attempt.status) {
    case "queued":
      return { kind: "queued", reason: "Review is queued." };
    case "running":
      return { kind: "running", reason: "Review is in progress." };
    case "cancelled":
      return { kind: "cancelled", reason: "Review attempt was cancelled." };
    case "superseded":
      return { kind: "no_attempt", reason: "Latest attempt was superseded without a completed review." };
    case "failed":
      return { kind: "errored", reason: "Review attempt failed before producing a decision." };
    case "completed":
      break;
  }
  switch (attempt.conclusion) {
    case "approved": return { kind: "approved" };
    case "declined": return { kind: "declined", reason: "Reviewer requested changes." };
    case "skipped": return { kind: "skipped", reason: "Review was intentionally skipped." };
    case "error": return { kind: "errored", reason: "Review produced an error outcome." };
    default: return { kind: "errored", reason: "Completed attempt has no recorded conclusion." };
  }
}

export function exitCodeForKind(kind: PrReviewKind): number {
  switch (kind) {
    case "approved":
    case "skipped":
      return 0;
    case "declined":
    case "errored":
    case "cancelled":
      return 2;
    case "queued":
    case "running":
    case "no_attempt":
      return 3;
  }
}

function isTerminalKind(kind: PrReviewKind): boolean {
  return exitCodeForKind(kind) !== 3;
}

function firstLine(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const line = summary.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : undefined;
}

export interface BuildReviewReportOptions {
  repoId: string;
  repoFullName: string;
  prNumber: number;
  attempt?: (ReviewAttemptRecord & { stale?: boolean; staleReason?: string }) | undefined;
}

export function buildPrReviewReport(options: BuildReviewReportOptions): PrReviewReport {
  const checkedAt = new Date().toISOString();
  const { kind, reason } = classifyAttempt(options.attempt);
  const summaryLine = firstLine(options.attempt?.summary);
  return {
    repoId: options.repoId,
    repoFullName: options.repoFullName,
    prNumber: options.prNumber,
    kind,
    terminal: isTerminalKind(kind),
    exitCode: exitCodeForKind(kind),
    ...(options.attempt ? { attempt: options.attempt } : {}),
    ...(summaryLine ? { summaryFirstLine: summaryLine } : {}),
    ...(reason ? { reason } : {}),
    checkedAt,
  };
}

function formatReportText(report: PrReviewReport): string {
  const lines = [
    `Repo: ${report.repoFullName} (${report.repoId})`,
    `PR: #${report.prNumber}`,
    `State: ${report.kind}`,
    `Terminal: ${report.terminal ? "yes" : "no"}`,
  ];
  if (report.reason) lines.push(`Reason: ${report.reason}`);
  if (report.attempt) {
    lines.push(`Attempt: #${report.attempt.id}`);
    lines.push(`Status: ${report.attempt.status}${report.attempt.conclusion ? ` (${report.attempt.conclusion})` : ""}`);
    lines.push(`Head SHA: ${report.attempt.headSha}`);
    if (report.attempt.stale) lines.push(`Stale: ${report.attempt.staleReason ?? "yes"}`);
    if (report.summaryFirstLine) lines.push(`Summary: ${report.summaryFirstLine}`);
  }
  return lines.join("\n") + "\n";
}

function selectLatestAttempt(attempts: Array<ReviewAttemptRecord & { stale?: boolean; staleReason?: string }>): (ReviewAttemptRecord & { stale?: boolean; staleReason?: string }) | undefined {
  if (attempts.length === 0) return undefined;
  const nonSuperseded = attempts.filter((attempt) => attempt.status !== "superseded");
  const pool = nonSuperseded.length > 0 ? nonSuperseded : attempts;
  pool.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return pool[0];
}

export interface HandlePrStatusOptions {
  parsed: ParsedArgs;
  stdout: Output;
  resolveCommand?: ResolveCommandRunner | undefined;
}

export async function handlePrStatus(options: HandlePrStatusOptions): Promise<number> {
  const { parsed, stdout } = options;
  const resolveCommand = options.resolveCommand;

  const resolvedRepo = await resolveRepo({ parsed, helpTopic: "root", runCommand: resolveCommand });
  const resolvedPr = await resolvePrNumber({ parsed, helpTopic: "root", runCommand: resolveCommand });

  const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
  const config = loadConfig(configPath);
  const { repo } = loadRepoConfigById(resolvedRepo.repoId);
  const store = new SqliteStore(config.database.path);
  try {
    const attempts = store.listAttemptsForPullRequest(repo.repoFullName, resolvedPr.prNumber, 50).map((attempt) =>
      decorateAttempt(attempt, {
        policy: {
          queuedAfterMs: config.reconciliation.staleQueuedAfterMs,
          runningAfterMs: config.reconciliation.staleRunningAfterMs,
        },
      }),
    );
    const selected = selectLatestAttempt(attempts);
    const report = buildPrReviewReport({
      repoId: resolvedRepo.repoId,
      repoFullName: repo.repoFullName,
      prNumber: resolvedPr.prNumber,
      attempt: selected,
    });

    // Reserved for --wait (shipped in a follow-up commit).
    void parseIntegerFlag(parsed.flags.get("timeout"), "--timeout");
    void parseIntegerFlag(parsed.flags.get("poll"), "--poll");

    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(report));
    } else {
      writeOutput(stdout, formatReportText(report));
    }
    return report.exitCode;
  } finally {
    store.close();
  }
}
