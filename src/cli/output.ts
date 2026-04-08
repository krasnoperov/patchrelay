import type { runPreflight } from "../preflight.ts";
import type { ClusterHealthReport } from "./cluster-health.ts";
import type { Output } from "./command-types.ts";
import type { CliUsageError } from "./errors.ts";
import { helpTextFor } from "./help.ts";

export function writeOutput(stream: Output, text: string): void {
  stream.write(text);
}

export function writeUsageError(stream: Output, error: CliUsageError): void {
  writeOutput(stream, `${helpTextFor(error.helpTopic)}\n\nError: ${error.message}\n`);
}

export function formatDoctor(report: Awaited<ReturnType<typeof runPreflight>>, cliVersion?: string, serviceVersion?: string): string {
  const lines = ["PatchRelay doctor", ""];

  if (cliVersion) {
    const versionLine = serviceVersion
      ? (cliVersion === serviceVersion ? `cli=${cliVersion}  service=${serviceVersion}` : `cli=${cliVersion}  service=${serviceVersion} (mismatch!)`)
      : `cli=${cliVersion}  service=not reachable`;
    lines.push(versionLine);
    lines.push("");
  }

  for (const check of report.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${marker} [${check.scope}] ${check.message}`);
  }

  lines.push("");
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}

export function formatClusterHealth(report: ClusterHealthReport): string {
  const lines = ["PatchRelay cluster", ""];

  for (const check of report.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    const detail = [
      check.scope,
      check.issueKey,
      check.prNumber !== undefined ? `PR #${check.prNumber}` : undefined,
    ].filter(Boolean).join(" ");
    lines.push(`${marker} [${detail}] ${check.message}`);
  }

  lines.push("");
  lines.push(
    `Summary: tracked=${report.summary.trackedIssues} open=${report.summary.openIssues} active=${report.summary.activeRuns} blocked=${report.summary.blockedIssues} ready=${report.summary.readyIssues}`,
  );
  lines.push(report.ok ? "Cluster result: healthy" : "Cluster result: attention needed");
  return `${lines.join("\n")}\n`;
}
