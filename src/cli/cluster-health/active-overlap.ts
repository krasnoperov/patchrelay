import type { IssueRecord } from "../../db-types.ts";
import type { CommandRunner, CommandRunnerResult } from "../command-types.ts";
import type { ClusterHealthCheck, IssueSnapshot } from "./types.ts";

interface ActiveWorktreeDiff {
  issue: IssueRecord;
  files: Set<string>;
}

export async function collectActiveOverlapFindings(
  snapshots: IssueSnapshot[],
  runCommand: CommandRunner,
): Promise<ClusterHealthCheck[]> {
  const findings: ClusterHealthCheck[] = [];
  const diffsByProject = new Map<string, ActiveWorktreeDiff[]>();

  for (const snapshot of snapshots) {
    const { issue } = snapshot;
    if (issue.activeRunId === undefined || !issue.worktreePath) {
      continue;
    }
    const files = await listModifiedTrackedFiles(runCommand, issue.worktreePath);
    if (files.size === 0) {
      continue;
    }
    const projectDiffs = diffsByProject.get(issue.projectId) ?? [];
    projectDiffs.push({ issue, files });
    diffsByProject.set(issue.projectId, projectDiffs);
  }

  for (const [projectId, diffs] of diffsByProject) {
    for (let leftIndex = 0; leftIndex < diffs.length; leftIndex += 1) {
      const left = diffs[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < diffs.length; rightIndex += 1) {
        const right = diffs[rightIndex]!;
        const overlap = [...left.files].filter((file) => right.files.has(file)).sort();
        if (overlap.length === 0) {
          continue;
        }
        findings.push({
          status: "warn",
          scope: "issue:overlap",
          message: `Active work overlaps with ${right.issue.issueKey ?? right.issue.linearIssueId}: ${overlap.slice(0, 3).join(", ")}${overlap.length > 3 ? " ..." : ""}`,
          ...(left.issue.issueKey ? { issueKey: left.issue.issueKey } : {}),
          projectId,
        });
      }
    }
  }

  return findings;
}

export async function listModifiedTrackedFiles(
  runCommand: CommandRunner,
  worktreePath: string,
): Promise<Set<string>> {
  let result: CommandRunnerResult;
  try {
    result = await runCommand("git", ["-C", worktreePath, "status", "--porcelain", "--untracked-files=no"]);
  } catch {
    return new Set();
  }
  if (result.exitCode !== 0) {
    return new Set();
  }

  const files = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const normalized = rawPath.includes(" -> ")
      ? rawPath.split(" -> ").at(-1)?.trim()
      : rawPath;
    if (normalized) {
      files.add(normalized);
    }
  }
  return files;
}
