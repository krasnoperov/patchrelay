import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import { resolvePreferredCompletedLinearState } from "./linear-workflow.ts";
import type { LinearClientProvider } from "./types.ts";

export class MergedLinearCompletionReconciler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
  ) {}

  async reconcile(): Promise<void> {
    for (const issue of this.db.issues.listIssues()) {
      if (issue.prState !== "merged") continue;
      if (issue.currentLinearStateType?.trim().toLowerCase() === "completed") continue;

      const linear = await this.linearProvider.forProject(issue.projectId).catch(() => undefined);
      if (!linear) continue;

      try {
        const liveIssue = await linear.getIssue(issue.linearIssueId);
        const targetState = resolvePreferredCompletedLinearState(liveIssue);
        if (!targetState) continue;

        const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
        if (normalizedCurrent === targetState.trim().toLowerCase()) {
          this.db.issues.upsertIssue({
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
            ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
          });
          continue;
        }

        const updated = await linear.setIssueState(issue.linearIssueId, targetState);
        this.db.issues.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(updated.stateName ? { currentLinearState: updated.stateName } : {}),
          ...(updated.stateType ? { currentLinearStateType: updated.stateType } : {}),
        });
      } catch (error) {
        this.logger.warn(
          { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
          "Failed to reconcile merged issue to a completed Linear state",
        );
      }
    }
  }
}
