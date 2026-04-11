import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { deriveLinearProgressFact } from "./linear-progress-facts.ts";
import type { LinearAgentActivityContent } from "./types.ts";

interface ProgressPublicationState {
  meaningKey: string;
  publishedAtMs: number;
}

export class LinearProgressReporter {
  private readonly publicationsByRun = new Map<number, ProgressPublicationState>();

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly emitActivity: (
      issue: IssueRecord,
      content: LinearAgentActivityContent,
      options?: { ephemeral?: boolean },
    ) => Promise<void>,
  ) {}

  maybeEmitProgress(notification: { method: string; params: Record<string, unknown> }, run: RunRecord): void {
    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (!issue) {
      return;
    }

    const fact = deriveLinearProgressFact(notification, issue);
    if (!fact) {
      return;
    }

    const previous = this.publicationsByRun.get(run.id);
    if (previous?.meaningKey === fact.meaningKey) {
      return;
    }

    const publication = {
      meaningKey: fact.meaningKey,
      publishedAtMs: Date.now(),
    };
    this.publicationsByRun.set(run.id, publication);
    void this.emitActivity(issue, fact.content, { ephemeral: true }).catch(() => {
      const current = this.publicationsByRun.get(run.id);
      if (current?.publishedAtMs === publication.publishedAtMs && current.meaningKey === publication.meaningKey) {
        this.publicationsByRun.delete(run.id);
      }
    });
  }

  clearProgress(runId: number): void {
    this.publicationsByRun.delete(runId);
  }
}
