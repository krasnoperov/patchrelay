import { getGateCheckNames } from "./idle-reconciliation-helpers.ts";
import {
  readIntegrationCandidateState,
  type IntegrationCandidateState,
} from "./integration-candidate-state.ts";
import type { AppConfig } from "./types.ts";

export type ConflictRepairOwnership =
  | { owner: "feature_branch"; candidateKind: "absent" }
  | {
      owner: "integration_candidate";
      candidateKind: Exclude<IntegrationCandidateState["kind"], "absent"> | "unknown";
      candidateSha?: string;
    };

/**
 * Resolve which workflow owns a merge conflict without mutating either
 * artifact. A published integration candidate owns the conflict. Uncertain
 * GitHub reads fail closed so an approved feature head stays frozen; only an
 * explicit missing candidate ref grants legacy feature-branch repair.
 */
export async function resolveConflictRepairOwnership(params: {
  project: AppConfig["projects"][number];
  prNumber: number;
  approvedHeadSha?: string;
  readCandidateState?: typeof readIntegrationCandidateState;
}): Promise<ConflictRepairOwnership> {
  const repoFullName = params.project.github?.repoFullName;
  if (!repoFullName || !params.approvedHeadSha) {
    return { owner: "integration_candidate", candidateKind: "unknown" };
  }

  const candidate = await (params.readCandidateState ?? readIntegrationCandidateState)({
    repoFullName,
    baseBranch: params.project.github?.baseBranch ?? "main",
    prNumber: params.prNumber,
    approvedHeadSha: params.approvedHeadSha,
    requiredChecks: getGateCheckNames(params.project),
  });
  if (candidate?.kind === "absent") {
    return { owner: "feature_branch", candidateKind: "absent" };
  }
  return {
    owner: "integration_candidate",
    candidateKind: candidate?.kind ?? "unknown",
    ...(candidate && "candidateSha" in candidate ? { candidateSha: candidate.candidateSha } : {}),
  };
}
