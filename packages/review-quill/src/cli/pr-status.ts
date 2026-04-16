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
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60_000;
const MAX_WAIT_TIMEOUT_MS = 2 * 60 * 60_000;
const MIN_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 5 * 60_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function resolveWaitOptions(parsed: ParsedArgs, overrides?: Partial<Pick<WaitOptions, "now" | "sleep">>): WaitOptions {
  const timeoutSeconds = parseIntegerFlag(parsed.flags.get("timeout"), "--timeout");
  const pollSeconds = parseIntegerFlag(parsed.flags.get("poll"), "--poll");
  const timeoutMs = clamp(
    timeoutSeconds !== undefined ? timeoutSeconds * 1000 : DEFAULT_WAIT_TIMEOUT_MS,
    MIN_WAIT_TIMEOUT_MS,
    MAX_WAIT_TIMEOUT_MS,
  );
  const pollMs = clamp(
    pollSeconds !== undefined ? pollSeconds * 1000 : DEFAULT_POLL_MS,
    MIN_POLL_MS,
    MAX_POLL_MS,
  );
  return {
    timeoutMs,
    pollMs,
    now: overrides?.now ?? (() => Date.now()),
    sleep: overrides?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

export async function waitForTerminalReport(
  build: () => Promise<PrReviewReport>,
  options: WaitOptions,
): Promise<{ report: PrReviewReport; timedOut: boolean }> {
  const deadline = options.now() + options.timeoutMs;
  let report = await build();
  while (!report.terminal) {
    const remaining = deadline - options.now();
    if (remaining <= 0) {
      return { report, timedOut: true };
    }
    const waitMs = Math.min(options.pollMs, remaining);
    if (waitMs > 0) await options.sleep(waitMs);
    report = await build();
  }
  return { report, timedOut: false };
}

export async function handlePrStatus(options: HandlePrStatusOptions): Promise<number> {
  const { parsed, stdout } = options;
  const resolveCommand = options.resolveCommand;

  const resolvedRepo = await resolveRepo({ parsed, helpTopic: "root", runCommand: resolveCommand });
  const resolvedPr = await resolvePrNumber({ parsed, helpTopic: "root", runCommand: resolveCommand });

  const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
  const config = loadConfig(configPath);
  const { repo } = loadRepoConfigById(resolvedRepo.repoId);

  const buildReport = async (): Promise<PrReviewReport> => {
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
      return buildPrReviewReport({
        repoId: resolvedRepo.repoId,
        repoFullName: repo.repoFullName,
        prNumber: resolvedPr.prNumber,
        attempt: selected,
      });
    } finally {
      store.close();
    }
  };

  const shouldWait = parsed.flags.get("wait") === true || typeof parsed.flags.get("wait") === "string";
  let report: PrReviewReport;
  let timedOut = false;
  if (shouldWait) {
    const waitOptions = resolveWaitOptions(parsed, {
      ...(options.now ? { now: options.now } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    const result = await waitForTerminalReport(buildReport, waitOptions);
    report = result.report;
    timedOut = result.timedOut;
  } else {
    report = await buildReport();
  }

  const payload = timedOut ? { ...report, timedOut: true } : report;
  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
  } else {
    writeOutput(stdout, formatReportText(report) + (timedOut ? "Timed out waiting for terminal state.\n" : ""));
  }
  return timedOut ? 4 : report.exitCode;
}
