import type { IssueRecord } from "./db-types.ts";
import type { ProjectConfig } from "./workflow-types.ts";

export const MAIN_REPAIR_BRANCH_PREFIX = "main-repair";

export interface MainRepairCheckSummary {
  baseSha: string;
  failingChecks: Array<{ name: string; url?: string }>;
  pendingChecks: Array<{ name: string; url?: string }>;
}

export function buildMainRepairBranchName(baseBranch: string): string {
  return `${MAIN_REPAIR_BRANCH_PREFIX}/${baseBranch}`;
}

export function isMainRepairIssue(issue: Pick<IssueRecord, "branchName">): boolean {
  return typeof issue.branchName === "string" && issue.branchName.startsWith(`${MAIN_REPAIR_BRANCH_PREFIX}/`);
}

export function buildMainRepairTitle(project: Pick<ProjectConfig, "github" | "id">): string {
  const repo = project.github?.repoFullName ?? project.id;
  const baseBranch = project.github?.baseBranch ?? "main";
  return `Repair ${baseBranch} for ${repo}`;
}

export function buildMainRepairDescription(
  project: Pick<ProjectConfig, "github" | "id">,
  summary: MainRepairCheckSummary,
  priorityLabel: string,
): string {
  const repo = project.github?.repoFullName ?? project.id;
  const baseBranch = project.github?.baseBranch ?? "main";
  const lines = [
    `Automatically created because \`${repo}@${baseBranch}\` is red.`,
    "",
    `Base SHA: \`${summary.baseSha}\``,
    "",
    "Repair the base-branch failure on a PR branch, get the PR green, and keep it in the priority queue lane.",
    `The repair PR must carry the GitHub label \`${priorityLabel}\`.`,
  ];
  if (summary.failingChecks.length > 0) {
    lines.push("", "Failing checks:");
    for (const check of summary.failingChecks) {
      lines.push(`- ${check.name}${check.url ? ` — ${check.url}` : ""}`);
    }
  }
  if (summary.pendingChecks.length > 0) {
    lines.push("", "Pending checks:");
    for (const check of summary.pendingChecks) {
      lines.push(`- ${check.name}${check.url ? ` — ${check.url}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function buildMainRepairPromptContext(
  project: Pick<ProjectConfig, "github" | "id">,
  summary: MainRepairCheckSummary,
  priorityLabel: string,
): string {
  const repo = project.github?.repoFullName ?? project.id;
  const baseBranch = project.github?.baseBranch ?? "main";
  const failingNames = summary.failingChecks.map((check) => check.name).join(", ") || "unknown failing checks";
  return [
    `Main repair for ${repo}.`,
    `${baseBranch} is red at ${summary.baseSha}.`,
    `Fix the failing base-branch checks (${failingNames}), publish a PR on this branch, and assign the GitHub label ${priorityLabel}.`,
  ].join(" ");
}
