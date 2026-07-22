import { spawnSync } from "node:child_process";
import path from "node:path";
import type { PatchRelayDatabase } from "../../db.ts";
import type { GitProbe, SequenceCandidate, SequenceRecommendation } from "../../pr-sequencing.ts";
import { detectStackingTarget } from "../../pr-sequencing.ts";
import { isIssuePublishedOrDownstreamProjection } from "../../issue-execution-state.ts";
import type { CliDataAccess } from "../data.ts";
import { CliUsageError } from "../errors.ts";
import { formatJson } from "../formatters/json.ts";
import type { Output, ParsedArgs } from "../command-types.ts";
import { writeOutput } from "../output.ts";

interface SequenceCheckParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  stderr: Output;
  data: CliDataAccess;
  cwd?: string;
  gitProbe?: GitProbe;
  candidatesProvider?: () => SequenceCandidate[];
  selfProvider?: () => { branch: string; headSha: string; baseRef: string } | undefined;
}

export async function handleSequenceCheckCommand(params: SequenceCheckParams): Promise<number> {
  if (params.commandArgs.length > 0) {
    throw new CliUsageError(
      `Unexpected argument for sequence-check: ${params.commandArgs[0]}`,
      "sequence-check",
    );
  }

  const cwd = params.cwd ?? process.cwd();
  const baseFlag = params.parsed.flags.get("base");
  const overrideBase = typeof baseFlag === "string" ? baseFlag.trim() : "";

  const self = params.selfProvider
    ? params.selfProvider()
    : resolveSelf(cwd, overrideBase || undefined);

  if (!self) {
    writeOutput(
      params.stderr,
      "sequence-check: not inside a git work tree, or unable to resolve HEAD\n",
    );
    return 2;
  }

  const candidates = params.candidatesProvider
    ? params.candidatesProvider()
    : collectCandidates(params.data.db, self.branch);

  const probe = params.gitProbe ?? cliGitProbe(cwd);
  const recommendation = await detectStackingTarget({
    self,
    candidates,
    git: probe,
  });

  if (params.json) {
    writeOutput(params.stdout, formatJson(recommendation));
  } else {
    writeOutput(params.stdout, `${JSON.stringify(recommendation)}\n`);
  }

  writeOutput(params.stderr, formatHumanSummary(recommendation));
  return 0;
}

function resolveSelf(
  cwd: string,
  overrideBase?: string,
): { branch: string; headSha: string; baseRef: string } | undefined {
  const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (branchResult.status !== 0) return undefined;
  const branch = branchResult.stdout.trim();
  if (!branch || branch === "HEAD") return undefined;

  const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (headResult.status !== 0) return undefined;
  const headSha = headResult.stdout.trim();
  if (!headSha) return undefined;

  const baseRef = overrideBase ?? resolveDefaultBranchRef(cwd);
  if (!baseRef) return undefined;

  return { branch, headSha, baseRef };
}

function resolveDefaultBranchRef(cwd: string): string {
  // Prefer the symbolic upstream of origin/HEAD; fall back to main.
  const symbolic = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (symbolic.status === 0) {
    const ref = symbolic.stdout.trim();
    if (ref) return ref;
  }
  for (const candidate of ["origin/main", "origin/master"]) {
    const probe = spawnSync("git", ["rev-parse", "--verify", candidate], {
      cwd,
      encoding: "utf8",
    });
    if (probe.status === 0) return candidate;
  }
  return "origin/main";
}

function collectCandidates(db: PatchRelayDatabase, selfBranch: string): SequenceCandidate[] {
  const issues = db.issues.listIssues();
  const candidates: SequenceCandidate[] = [];
  const now = Date.now();
  for (const issue of issues) {
    if (!isIssuePublishedOrDownstreamProjection(issue)) continue;
    if (!issue.branchName || !issue.prHeadSha || !issue.prNumber) continue;
    if (issue.branchName === selfBranch) continue;
    const queueAgeMs = issue.updatedAt
      ? Math.max(0, now - Date.parse(issue.updatedAt))
      : undefined;
    candidates.push({
      prNumber: issue.prNumber,
      branch: issue.branchName,
      headSha: issue.prHeadSha,
      ...(issue.prReviewState ? { reviewState: issue.prReviewState } : {}),
      ...(issue.prCheckStatus ? { checkStatus: issue.prCheckStatus } : {}),
      queueSignalled: issue.lastQueueSignalAt !== undefined,
      ...(queueAgeMs !== undefined ? { queueAgeMs } : {}),
    });
  }
  return candidates;
}

function cliGitProbe(cwd: string): GitProbe {
  return {
    async changedFiles(baseRef: string, headSha: string): Promise<string[]> {
      const result = spawnSync(
        "git",
        ["diff", "--name-only", `${baseRef}...${headSha}`],
        { cwd, encoding: "utf8" },
      );
      if (result.status !== 0) {
        return [];
      }
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },
    async hasConflict(headSha: string, candidateHeadSha: string): Promise<boolean> {
      // `git merge-tree --write-tree` exits non-zero on conflict in
      // modern git; with `--no-messages` it suppresses commit-msg
      // suggestions. Use the auto-merge-base form (two operands).
      const result = spawnSync(
        "git",
        ["merge-tree", "--write-tree", "--no-messages", headSha, candidateHeadSha],
        { cwd, encoding: "utf8" },
      );
      return result.status !== 0;
    },
  };
}

function formatHumanSummary(recommendation: SequenceRecommendation): string {
  if (recommendation.recommendation === "open_pr_against_main") {
    return `sequence-check: open PR against main — ${recommendation.reason}\n`;
  }
  return [
    `sequence-check: rebase onto PR #${recommendation.parentPr} (${recommendation.parentBranch})`,
    `  reason: ${recommendation.reason}`,
    `  parent head: ${recommendation.parentHead}`,
    "",
  ].join("\n");
}

// Re-export type-level helpers so callers can mock them.
export type { GitProbe, SequenceCandidate };
export { path };
