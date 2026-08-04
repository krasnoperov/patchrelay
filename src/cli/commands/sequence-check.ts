import { spawnSync } from "node:child_process";
import path from "node:path";
import type { GitProbe, SequenceCandidate, SequenceRecommendation } from "../../pr-sequencing.ts";
import { detectStackingTarget } from "../../pr-sequencing.ts";
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

  let candidates: SequenceCandidate[];
  try {
    candidates = params.candidatesProvider
      ? params.candidatesProvider()
      : collectCandidates(cwd, self.branch);
  } catch (error) {
    writeOutput(
      params.stderr,
      `sequence-check: unable to read live open PRs for this repository: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  if (!params.gitProbe) {
    const fetchResult = spawnSync("git", ["fetch", "origin", "--prune"], { cwd, encoding: "utf8" });
    if (fetchResult.status !== 0) {
      writeOutput(
        params.stderr,
        `sequence-check: unable to refresh repository refs: ${fetchResult.stderr.trim() || "git fetch failed"}\n`,
      );
      return 2;
    }
  }

  const probe = params.gitProbe ?? cliGitProbe(cwd);
  let recommendation: SequenceRecommendation;
  try {
    recommendation = await detectStackingTarget({
      self,
      candidates,
      git: probe,
    });
  } catch (error) {
    writeOutput(
      params.stderr,
      `sequence-check: unable to prove independent PR ancestry: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  if (params.json) {
    writeOutput(params.stdout, formatJson(recommendation));
  } else {
    writeOutput(params.stdout, `${JSON.stringify(recommendation)}\n`);
  }

  writeOutput(params.stderr, formatHumanSummary(recommendation));
  return recommendation.recommendation === "blocked_open_pr_ancestry" ? 1 : 0;
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

function collectCandidates(cwd: string, selfBranch: string): SequenceCandidate[] {
  const result = spawnSync(
    "gh",
    ["pr", "list", "--state", "open", "--limit", "1000", "--json", "number,headRefName,headRefOid"],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "gh pr list failed");
  }
  const payload = JSON.parse(result.stdout) as Array<{
    number?: unknown;
    headRefName?: unknown;
    headRefOid?: unknown;
  }>;
  if (!Array.isArray(payload)) throw new Error("gh pr list returned malformed data");
  return payload.flatMap((candidate) =>
    typeof candidate.number === "number"
      && typeof candidate.headRefName === "string"
      && typeof candidate.headRefOid === "string"
      && candidate.headRefName !== selfBranch
      ? [{
          prNumber: candidate.number,
          branch: candidate.headRefName,
          headSha: candidate.headRefOid,
        }]
      : []
  );
}

function cliGitProbe(cwd: string): GitProbe {
  return {
    async mergeBase(leftSha: string, rightSha: string): Promise<string> {
      const result = spawnSync("git", ["merge-base", leftSha, rightSha], { cwd, encoding: "utf8" });
      if (result.status !== 0 || !result.stdout.trim()) {
        throw new Error(result.stderr.trim() || "git merge-base failed");
      }
      return result.stdout.trim();
    },
    async isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean> {
      const result = spawnSync(
        "git",
        ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
        { cwd, encoding: "utf8" },
      );
      if (result.status === 0) return true;
      if (result.status === 1) return false;
      throw new Error(result.stderr.trim() || "git merge-base --is-ancestor failed");
    },
  };
}

function formatHumanSummary(recommendation: SequenceRecommendation): string {
  if (recommendation.recommendation === "open_pr_against_main") {
    return `sequence-check: open PR against main — ${recommendation.reason}\n`;
  }
  return `sequence-check: blocked — ${recommendation.reason}\n`;
}

// Re-export type-level helpers so callers can mock them.
export type { GitProbe, SequenceCandidate };
export { path };
