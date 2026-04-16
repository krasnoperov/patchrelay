import { SqliteStore } from "../../db/sqlite-store.ts";
import type { QueueEntry, QueueWatchSnapshot } from "../../types.ts";
import type { StewardConfig } from "../../config.ts";
import type { Output, ParsedArgs } from "../types.ts";
import { formatJson, writeOutput } from "../output.ts";
import { ServiceApiError, fetchLocalJson, loadRepoConfigById } from "../system.ts";
import { defaultResolveRunner, resolvePrNumber, resolveRepo, type ResolveCommandRunner } from "../resolve.ts";
import { parseIntegerFlag } from "../args.ts";
import { fetchPrGitHubOverview, type PrGitHubOverview } from "./pr-github.ts";

export type PrStatusKind =
  | "merged"
  | "merged_outside_queue"
  | "queued"
  | "preparing_head"
  | "validating"
  | "merging"
  | "evicted"
  | "dequeued"
  | "closed"
  | "changes_requested"
  | "checks_failing"
  | "checks_pending"
  | "approved_clean"
  | "not_queued";

export type PrStatusSource = "queue" | "github";

export interface PrStatusReport {
  repoId: string;
  repoFullName: string;
  prNumber: number;
  source: PrStatusSource;
  kind: PrStatusKind;
  terminal: boolean;
  exitCode: number;
  reason?: string;
  queueEntry?: QueueEntry;
  github?: PrGitHubOverview;
  checkedAt: string;
}

export function classifyQueueEntry(entry: QueueEntry): PrStatusReport["kind"] {
  switch (entry.status) {
    case "merged": return "merged";
    case "queued": return "queued";
    case "preparing_head": return "preparing_head";
    case "validating": return "validating";
    case "merging": return "merging";
    case "evicted": return "evicted";
    case "dequeued": return "dequeued";
  }
}

function exitCodeForKind(kind: PrStatusReport["kind"]): number {
  switch (kind) {
    case "merged":
    case "merged_outside_queue":
    case "approved_clean":
      return 0;
    case "closed":
    case "changes_requested":
    case "checks_failing":
    case "evicted":
    case "dequeued":
      return 2;
    case "queued":
    case "preparing_head":
    case "validating":
    case "merging":
    case "checks_pending":
    case "not_queued":
      return 3;
  }
}

function isTerminalKind(kind: PrStatusReport["kind"]): boolean {
  return exitCodeForKind(kind) !== 3;
}

export function classifyGitHubOverview(overview: PrGitHubOverview): { kind: PrStatusReport["kind"]; reason?: string } {
  if (overview.state === "MERGED" || overview.merged) {
    return { kind: "merged_outside_queue" };
  }
  if (overview.state === "CLOSED") {
    return { kind: "closed", reason: "PR is closed without merge" };
  }
  if (overview.reviewDecision === "CHANGES_REQUESTED") {
    return { kind: "changes_requested", reason: "A reviewer requested changes" };
  }
  const requiredChecks = overview.checks.filter((c) => c.required);
  const checkPool = requiredChecks.length > 0 ? requiredChecks : overview.checks;
  const failing = checkPool.filter((c) => c.status === "failure").map((c) => c.name);
  if (failing.length > 0) {
    return { kind: "checks_failing", reason: `Failing checks: ${failing.join(", ")}` };
  }
  const pending = checkPool.filter((c) => c.status === "pending").map((c) => c.name);
  if (pending.length > 0) {
    return { kind: "checks_pending", reason: `Pending checks: ${pending.join(", ")}` };
  }
  if (overview.reviewDecision === "APPROVED") {
    return { kind: "approved_clean", reason: "Approved with green checks; not admitted to queue" };
  }
  return { kind: "not_queued", reason: "PR is not admitted to the merge queue" };
}

function findEntryForPr(snapshot: QueueWatchSnapshot, prNumber: number): QueueEntry | undefined {
  const matches = snapshot.entries.filter((entry) => entry.prNumber === prNumber);
  if (matches.length === 0) return undefined;
  matches.sort((left, right) => {
    const leftTerminal = ["merged", "evicted", "dequeued"].includes(left.status) ? 1 : 0;
    const rightTerminal = ["merged", "evicted", "dequeued"].includes(right.status) ? 1 : 0;
    if (leftTerminal !== rightTerminal) return leftTerminal - rightTerminal;
    return right.position - left.position;
  });
  return matches[0];
}

async function loadQueueEntry(config: StewardConfig, prNumber: number): Promise<
  | { kind: "found"; entry: QueueEntry; source: "service" | "database" }
  | { kind: "not_found" }
  | { kind: "unavailable" }
> {
  try {
    const snapshot = await fetchLocalJson<QueueWatchSnapshot>(config.repoId, "/queue/watch?eventLimit=1");
    const entry = findEntryForPr(snapshot, prNumber);
    return entry ? { kind: "found", entry, source: "service" } : { kind: "not_found" };
  } catch (error) {
    if (error instanceof ServiceApiError) {
      return { kind: "unavailable" };
    }
    const store = new SqliteStore(config.database.path);
    try {
      const entries = store.listAll(config.repoId).filter((entry) => entry.prNumber === prNumber);
      if (entries.length === 0) return { kind: "not_found" };
      entries.sort((left, right) => {
        const leftTerminal = ["merged", "evicted", "dequeued"].includes(left.status) ? 1 : 0;
        const rightTerminal = ["merged", "evicted", "dequeued"].includes(right.status) ? 1 : 0;
        if (leftTerminal !== rightTerminal) return leftTerminal - rightTerminal;
        return right.position - left.position;
      });
      return { kind: "found", entry: entries[0]!, source: "database" };
    } finally {
      store.close();
    }
  }
}

export interface BuildReportOptions {
  repoId: string;
  repoFullName: string;
  prNumber: number;
  queueEntry?: QueueEntry | undefined;
  github?: PrGitHubOverview | undefined;
}

export function buildPrStatusReport(options: BuildReportOptions): PrStatusReport {
  const checkedAt = new Date().toISOString();
  if (options.queueEntry) {
    const kind = classifyQueueEntry(options.queueEntry);
    return {
      repoId: options.repoId,
      repoFullName: options.repoFullName,
      prNumber: options.prNumber,
      source: "queue",
      kind,
      terminal: isTerminalKind(kind),
      exitCode: exitCodeForKind(kind),
      queueEntry: options.queueEntry,
      checkedAt,
    };
  }
  if (options.github) {
    const { kind, reason } = classifyGitHubOverview(options.github);
    return {
      repoId: options.repoId,
      repoFullName: options.repoFullName,
      prNumber: options.prNumber,
      source: "github",
      kind,
      terminal: isTerminalKind(kind),
      exitCode: exitCodeForKind(kind),
      ...(reason ? { reason } : {}),
      github: options.github,
      checkedAt,
    };
  }
  throw new Error("buildPrStatusReport requires either queueEntry or github overview");
}

function formatReportText(report: PrStatusReport): string {
  const lines = [
    `Repo: ${report.repoFullName} (${report.repoId})`,
    `PR: #${report.prNumber}`,
    `Source: ${report.source}`,
    `State: ${report.kind}`,
    `Terminal: ${report.terminal ? "yes" : "no"}`,
  ];
  if (report.reason) lines.push(`Reason: ${report.reason}`);
  if (report.queueEntry) {
    const entry = report.queueEntry;
    lines.push(`Queue position: ${entry.position}`);
    lines.push(`Branch: ${entry.branch}`);
    lines.push(`Head SHA: ${entry.headSha}`);
    if (entry.waitDetail) lines.push(`Wait detail: ${entry.waitDetail}`);
  }
  if (report.github) {
    const gh = report.github;
    lines.push(`Review decision: ${gh.reviewDecision || "(none)"}`);
    if (gh.mergeStateStatus) lines.push(`Merge state: ${gh.mergeStateStatus}`);
    if (gh.labels.length > 0) lines.push(`Labels: ${gh.labels.join(", ")}`);
    if (gh.checks.length > 0) {
      const required = gh.checks.filter((c) => c.required);
      const summary = required.length > 0 ? required : gh.checks;
      const bySt = {
        success: summary.filter((c) => c.status === "success").length,
        failure: summary.filter((c) => c.status === "failure").length,
        pending: summary.filter((c) => c.status === "pending").length,
      };
      lines.push(`Checks (${required.length > 0 ? "required" : "all"}): ${bySt.success} ok, ${bySt.failure} failing, ${bySt.pending} pending`);
      for (const check of summary) {
        lines.push(`  - [${check.status}] ${check.name}${check.required ? " (required)" : ""}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

export interface HandlePrStatusOptions {
  parsed: ParsedArgs;
  stdout: Output;
  resolveCommand?: ResolveCommandRunner | undefined;
  /** For tests: inject a custom fetcher instead of shelling to `gh`. */
  fetchGitHub?: ((repoFullName: string, prNumber: number) => Promise<PrGitHubOverview>) | undefined;
  /** For tests: inject a clock. Defaults to Date.now. */
  now?: (() => number) | undefined;
  /** For tests: inject a sleep. Defaults to setTimeout. */
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function waitForTerminalReport(
  build: () => Promise<PrStatusReport>,
  options: WaitOptions,
): Promise<{ report: PrStatusReport; timedOut: boolean }> {
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
  const { config } = loadRepoConfigById(resolvedRepo.repoId);

  const fetchGh = options.fetchGitHub
    ?? ((repoFullName, prNumber) =>
      fetchPrGitHubOverview(repoFullName, prNumber, resolveCommand ?? defaultResolveRunner));

  const buildReport = async (): Promise<PrStatusReport> => {
    const queueResult = await loadQueueEntry(config, resolvedPr.prNumber);
    if (queueResult.kind === "found") {
      return buildPrStatusReport({
        repoId: resolvedRepo.repoId,
        repoFullName: resolvedRepo.repoFullName,
        prNumber: resolvedPr.prNumber,
        queueEntry: queueResult.entry,
      });
    }
    const overview = await fetchGh(resolvedRepo.repoFullName, resolvedPr.prNumber);
    return buildPrStatusReport({
      repoId: resolvedRepo.repoId,
      repoFullName: resolvedRepo.repoFullName,
      prNumber: resolvedPr.prNumber,
      github: overview,
    });
  };

  const shouldWait = parsed.flags.get("wait") === true || typeof parsed.flags.get("wait") === "string";
  let report: PrStatusReport;
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
