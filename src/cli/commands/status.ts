import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "../../types.ts";
import type { CommandRunner, Output } from "../command-types.ts";
import { collectClusterHealth } from "../cluster-health/index.ts";
import type { CliDataAccess } from "../data.ts";
import { CliUsageError } from "../errors.ts";
import { formatJson } from "../formatters/json.ts";
import { formatTrace } from "../formatters/text.ts";
import type { OperatorIssueStatusResult } from "../operator-client.ts";
import { formatClusterHealth, writeOutput } from "../output.ts";

interface StatusCommandParams {
  issueKey?: string;
  follow: boolean;
  trace: boolean;
  json: boolean;
  stdout: Output;
  data: CliDataAccess;
  config: AppConfig;
  runCommand: CommandRunner;
}

export async function handleStatusCommand(params: StatusCommandParams): Promise<number> {
  if (params.follow && params.json) {
    throw new CliUsageError("--json cannot be combined with --follow.");
  }
  if (!params.issueKey) {
    if (params.follow || params.trace) {
      throw new CliUsageError("--follow and --trace require an issue key.");
    }
    const report = await collectClusterHealth(params.config, params.data.db, params.runCommand);
    writeOutput(params.stdout, params.json ? formatJson(report) : formatClusterHealth(report).replace("PatchRelay cluster", "PatchRelay status"));
    return report.ok ? 0 : 1;
  }

  for (;;) {
    const status = await params.data.getIssueStatus(params.issueKey);
    const trace = params.trace ? params.data.trace(params.issueKey) : undefined;
    if (params.trace && !trace) throw new Error(`Issue not found: ${params.issueKey}`);
    writeOutput(
      params.stdout,
      params.json
        ? formatJson({ ...status, ...(trace ? { trace } : {}) })
        : `${formatIssueStatus(status)}${trace ? `\n${formatTrace(trace)}` : ""}`,
    );
    if (!params.follow || status.activeRun?.status !== "running") return 0;
    await delay(2000);
  }
}

function formatIssueStatus(status: OperatorIssueStatusResult): string {
  const issueKey = status.issue.issueKey ?? "unknown";
  const run = status.activeRun ?? status.latestRun;
  const live = status.liveThread;
  const latestMessage = live?.latestAgentMessage ?? status.latestReportSummary?.latestAssistantMessage ?? status.activity?.summary;
  const counts = live ?? status.latestReportSummary;
  const lines = [
    `${issueKey}${status.issue.title ? ` · ${status.issue.title}` : ""}`,
    "",
    field("Phase", status.issue.phase),
    field("Linear", status.issue.currentLinearState),
    field("Owner", resolveOwner(status)),
    field("Run", run ? `#${run.id} · ${run.runType} · ${run.status}${run.startedAt ? ` · ${formatAge(run.startedAt)}` : ""}` : "none"),
    field("Activity", status.activity ? `${formatAgo(status.activity.at)} · ${status.activity.kind ?? "codex"}${status.activity.summary ? ` · ${status.activity.summary}` : ""}` : live ? "available from Codex; timestamp unavailable" : "unknown"),
    field("Agent", latestMessage ?? "No agent summary yet"),
    field("Plan", live?.latestPlan),
    field("Command", live?.activeCommand),
    counts ? field("Work", `${counts.commandCount ?? 0} commands · ${counts.fileChangeCount ?? 0} file changes · ${counts.toolCallCount ?? 0} tool calls`) : undefined,
    field("PR", status.issue.prNumber !== undefined ? `#${status.issue.prNumber} · ${status.issue.prState ?? "unknown"} · review ${status.issue.prReviewState ?? "unknown"} · checks ${status.issue.prCheckStatus ?? "unknown"}` : "not opened"),
    field("Next", status.issue.waitingReason ?? status.issue.statusNote),
    status.codexError ? field("Codex", `unavailable: ${status.codexError}`) : undefined,
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\n")}\n`;
}

function resolveOwner(status: OperatorIssueStatusResult): string {
  if (status.activeRun?.status === "running") return status.liveThread ? "PatchRelay / Codex (confirmed live)" : "PatchRelay / Codex (recorded; live thread unavailable)";
  if (status.issue.waitingReason) return status.issue.waitingReason;
  return "none";
}

function field(label: string, value: string | number | undefined | null): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : `${label.padEnd(10)} ${value}`;
}

function formatAge(startedAt: string): string {
  return `${formatDuration(Date.now() - Date.parse(startedAt))} elapsed`;
}

function formatAgo(at: string): string {
  return `${formatDuration(Date.now() - Date.parse(at))} ago`;
}

function formatDuration(rawMs: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(rawMs) ? rawMs / 1000 : 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
