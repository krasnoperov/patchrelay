import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { deriveLinearProgressFact } from "./linear-progress-facts.ts";
import type { LinearAgentActivityContent } from "./types.ts";

interface ProgressPublicationState {
  ephemeralMeaningKey?: string;
  ephemeralPublishedAtMs?: number;
  historyMeaningKey?: string;
  historyPublishedAtMs?: number;
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
    const shouldEmitEphemeral = previous?.ephemeralMeaningKey !== fact.meaningKey;
    const shouldEmitHistory = previous?.historyMeaningKey !== fact.meaningKey;
    if (!shouldEmitEphemeral && !shouldEmitHistory) {
      return;
    }

    const now = Date.now();
    const publication: ProgressPublicationState = {
      ...previous,
      ...(shouldEmitEphemeral
        ? {
            ephemeralMeaningKey: fact.meaningKey,
            ephemeralPublishedAtMs: now,
          }
        : {}),
      ...(shouldEmitHistory
        ? {
            historyMeaningKey: fact.meaningKey,
            historyPublishedAtMs: now,
          }
        : {}),
    };
    this.publicationsByRun.set(run.id, publication);

    if (shouldEmitEphemeral) {
      void this.emitActivity(issue, fact.ephemeralContent, { ephemeral: true }).catch(() => {
        this.clearFailedPublication(run.id, "ephemeral", fact.meaningKey, now);
      });
    }

    if (shouldEmitHistory) {
      void this.emitActivity(issue, fact.historyContent).catch(() => {
        this.clearFailedPublication(run.id, "history", fact.meaningKey, now);
      });
    }
  }

  clearProgress(runId: number): void {
    this.publicationsByRun.delete(runId);
  }

  private clearFailedPublication(
    runId: number,
    channel: "ephemeral" | "history",
    meaningKey: string,
    publishedAtMs: number,
  ): void {
    const current = this.publicationsByRun.get(runId);
    if (!current) {
      return;
    }

    if (channel === "ephemeral") {
      if (current.ephemeralMeaningKey !== meaningKey || current.ephemeralPublishedAtMs !== publishedAtMs) {
        return;
      }
      const next: ProgressPublicationState = {};
      if (current.historyMeaningKey !== undefined) {
        next.historyMeaningKey = current.historyMeaningKey;
      }
      if (current.historyPublishedAtMs !== undefined) {
        next.historyPublishedAtMs = current.historyPublishedAtMs;
      }
      if (!next.historyMeaningKey) {
        this.publicationsByRun.delete(runId);
        return;
      }
      this.publicationsByRun.set(runId, next);
      return;
    }

    if (current.historyMeaningKey !== meaningKey || current.historyPublishedAtMs !== publishedAtMs) {
      return;
    }
    const next: ProgressPublicationState = {};
    if (current.ephemeralMeaningKey !== undefined) {
      next.ephemeralMeaningKey = current.ephemeralMeaningKey;
    }
    if (current.ephemeralPublishedAtMs !== undefined) {
      next.ephemeralPublishedAtMs = current.ephemeralPublishedAtMs;
    }
    if (!next.ephemeralMeaningKey) {
      this.publicationsByRun.delete(runId);
      return;
    }
    this.publicationsByRun.set(runId, next);
  }
}
