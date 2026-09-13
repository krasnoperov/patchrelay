import type { AppConfig } from "./types.ts";
import type { IntegrationCandidateState } from "./integration-candidate-state.ts";
import { readIntegrationCandidateState, readRequiredChecksState } from "./integration-candidate-state.ts";
import { getGateCheckNames } from "./github-webhook-policy.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { execCommand } from "./utils.ts";

export interface GitHubNativeCandidateRepair {
  projectId: string;
  repoFullName: string;
  prNumber: number;
  title: string;
  url?: string;
  headBranch: string;
  headSha: string;
  candidate: Extract<IntegrationCandidateState, { kind: "conflicted" | "failed" }>;
}

function parseCandidatePrNumber(ref: string, baseBranch: string): number | undefined {
  const prefix = `refs/heads/merge-steward/${baseBranch}/pr-`;
  if (!ref.startsWith(prefix)) return undefined;
  const suffix = ref.slice(prefix.length);
  return /^\d+$/.test(suffix) ? Number(suffix) : undefined;
}

/**
 * Discover repairable integration candidates using only the shared GitHub
 * protocol. Exact-head approval and branch CI are revalidated before work is
 * returned, so candidate existence alone never grants feature authority.
 */
export async function discoverGitHubNativeCandidateRepairs(params: {
  config: AppConfig;
  isTracked: (projectId: string, prNumber: number) => boolean;
  runCommand?: typeof execCommand;
  onCommandError?: (context: { repoFullName: string; error: string }) => void;
}): Promise<GitHubNativeCandidateRepair[]> {
  const runCommand = params.runCommand ?? execCommand;
  const repairs: GitHubNativeCandidateRepair[] = [];

  for (const project of params.config.projects) {
    const repoFullName = project.github?.repoFullName;
    if (!repoFullName) continue;
    const safeRunCommand: typeof execCommand = async (command, args, options) => {
      try {
        return await runCommand(command, args, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        params.onCommandError?.({ repoFullName, error: message });
        return { stdout: "", stderr: message, exitCode: 1 };
      }
    };
    const baseBranch = resolveMergeQueueProtocol(project).baseBranch ?? "main";
    const refs = await safeRunCommand("gh", [
      "api",
      `repos/${repoFullName}/git/matching-refs/heads/merge-steward/${baseBranch}/pr-`,
      "--paginate",
      "--jq",
      ".[].ref",
    ], { timeoutMs: 10_000 });
    if (refs.exitCode !== 0) continue;

    const prNumbers = [...new Set(refs.stdout.split(/\r?\n/)
      .map((ref) => parseCandidatePrNumber(ref.trim(), baseBranch))
      .filter((value): value is number => value !== undefined))];

    for (const prNumber of prNumbers) {
      if (params.isTracked(project.id, prNumber)) continue;
      const prResult = await safeRunCommand("gh", [
        "pr", "view", String(prNumber),
        "--repo", repoFullName,
        "--json", "state,isDraft,title,url,headRefName,headRefOid,baseRefName,reviewDecision,reviews",
      ], { timeoutMs: 10_000 });
      if (prResult.exitCode !== 0) continue;
      let pr: {
        state?: string;
        isDraft?: boolean;
        title?: string;
        url?: string;
        headRefName?: string;
        headRefOid?: string;
        baseRefName?: string;
        reviewDecision?: string;
        reviews?: Array<{ state?: string; commit?: { oid?: string } }>;
      };
      try {
        pr = JSON.parse(prResult.stdout) as typeof pr;
      } catch {
        continue;
      }
      if (pr.state !== "OPEN" || pr.isDraft || pr.baseRefName !== baseBranch || !pr.headRefOid || !pr.headRefName) continue;
      const exactApproval = pr.reviewDecision === "APPROVED"
        && (pr.reviews ?? []).some((review) => review.state === "APPROVED" && review.commit?.oid === pr.headRefOid);
      if (!exactApproval) continue;

      const requiredChecks = getGateCheckNames(project);
      const branchChecks = await readRequiredChecksState({
        repoFullName,
        ref: pr.headRefOid,
        requiredChecks,
        runCommand: safeRunCommand,
      });
      if (branchChecks?.kind !== "green") continue;
      const candidate = await readIntegrationCandidateState({
        repoFullName,
        baseBranch,
        prNumber,
        approvedHeadSha: pr.headRefOid,
        requiredChecks,
        runCommand: safeRunCommand,
      });
      if (candidate?.kind !== "conflicted" && candidate?.kind !== "failed") continue;

      repairs.push({
        projectId: project.id,
        repoFullName,
        prNumber,
        title: pr.title ?? `GitHub PR #${prNumber}`,
        ...(pr.url ? { url: pr.url } : {}),
        headBranch: pr.headRefName,
        headSha: pr.headRefOid,
        candidate,
      });
    }
  }
  return repairs;
}
