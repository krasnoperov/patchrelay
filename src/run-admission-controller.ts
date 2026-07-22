import type { PatchRelayDatabase } from "./db.ts";
import type { RunType } from "./run-type.ts";
import type { LinearIssueProjectionService } from "./linear-issue-projection.ts";

export type RunAdmissionResult =
  | { allowed: true }
  | { allowed: false; reason: "dependency_refresh_failed"; knownDependencyRows: number }
  | { allowed: false; reason: "blocked"; blockerCount: number };

export type RunAdmissionFailure = Exclude<RunAdmissionResult, { allowed: true }>;

export function shouldConsumeWorkflowTaskOnAdmissionFailure(result: RunAdmissionFailure): boolean {
  switch (result.reason) {
    case "dependency_refresh_failed":
      return false;
    case "blocked":
      return true;
  }
}

export class RunAdmissionController {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly linearIssueProjection: LinearIssueProjectionService,
  ) {}

  async check(params: {
    projectId: string;
    linearIssueId: string;
    runType: RunType;
  }): Promise<RunAdmissionResult> {
    if (params.runType !== "implementation") {
      return { allowed: true };
    }

    const knownDependencyRows = this.db.issues.listIssueDependencies(params.projectId, params.linearIssueId).length;
    const refresh = await this.linearIssueProjection.refreshIssue(params.projectId, params.linearIssueId);
    if (!refresh.refreshed && knownDependencyRows > 0) {
      return { allowed: false, reason: "dependency_refresh_failed", knownDependencyRows };
    }

    const blockerCount = this.db.issues.countUnresolvedBlockers(params.projectId, params.linearIssueId);
    if (blockerCount > 0) {
      return { allowed: false, reason: "blocked", blockerCount };
    }

    return { allowed: true };
  }
}
