import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { deriveLinearProgressFact } from "./linear-progress-facts.ts";
import { isSqliteSchemaReadError } from "./sqlite-errors.ts";
import type { LinearAgentActivityContent } from "./types.ts";

interface ProgressPublicationState {
  ephemeralMeaningKey?: string;
  ephemeralPublishedAtMs?: number;
  historyMeaningKey?: string;
  historyPublishedAtMs?: number;
  quietSinceMs?: number;
  lastHeartbeatAtMs?: number;
}

export class LinearProgressReporter {
  private static readonly DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
  private readonly publicationsByRun = new Map<number, ProgressPublicationState>();

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly emitActivity: (
      issue: IssueRecord,
      content: LinearAgentActivityContent,
      options?: { ephemeral?: boolean },
    ) => Promise<void>,
    private readonly options: {
      heartbeatIntervalMs?: number;
      now?: () => number;
    } = {},
  ) {}

  maybeEmitProgress(notification: { method: string; params: Record<string, unknown> }, run: RunRecord): void {
    const issue = this.getIssueWithSchemaRetry(run);
    if (!issue) {
      return;
    }

    const fact = deriveLinearProgressFact(notification, issue);
    if (!fact) {
      this.maybeEmitHeartbeat(notification, run);
      return;
    }

    const previous = this.publicationsByRun.get(run.id);
    const shouldEmitEphemeral = previous?.ephemeralMeaningKey !== fact.meaningKey;
    const shouldEmitHistory = previous?.historyMeaningKey !== fact.meaningKey;
    if (!shouldEmitEphemeral && !shouldEmitHistory) {
      return;
    }

    const now = this.now();
    const publication: ProgressPublicationState = {
      ...previous,
      quietSinceMs: now,
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

  private maybeEmitHeartbeat(notification: { method: string; params: Record<string, unknown> }, run: RunRecord): void {
    const previous = this.publicationsByRun.get(run.id);
    const now = this.now();
    const quietSinceMs = previous?.quietSinceMs ?? previous?.ephemeralPublishedAtMs ?? previous?.historyPublishedAtMs ?? now;
    const elapsedMs = now - quietSinceMs;
    const intervalMs = this.options.heartbeatIntervalMs ?? LinearProgressReporter.DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (elapsedMs < intervalMs) {
      if (!previous) {
        this.publicationsByRun.set(run.id, { quietSinceMs });
      }
      return;
    }
    if (previous?.lastHeartbeatAtMs !== undefined && now - previous.lastHeartbeatAtMs < intervalMs) {
      return;
    }

    const issue = this.getIssueWithSchemaRetry(run);
    if (!issue) {
      return;
    }
    const detail = describeHeartbeatDetail(notification);
    const content: LinearAgentActivityContent = {
      type: "thought",
      body: detail
        ? `PatchRelay is still working on ${run.runType.replaceAll("_", " ")}. Latest signal: ${detail}.`
        : `PatchRelay is still working on ${run.runType.replaceAll("_", " ")}.`,
    };
    this.publicationsByRun.set(run.id, {
      ...previous,
      quietSinceMs,
      lastHeartbeatAtMs: now,
    });
    void this.emitActivity(issue, content, { ephemeral: true }).catch(() => {
      const current = this.publicationsByRun.get(run.id);
      if (current?.lastHeartbeatAtMs === now) {
        const restored: ProgressPublicationState = {
          ...current,
        };
        if (previous?.lastHeartbeatAtMs !== undefined) {
          restored.lastHeartbeatAtMs = previous.lastHeartbeatAtMs;
        } else {
          delete restored.lastHeartbeatAtMs;
        }
        this.publicationsByRun.set(run.id, restored);
      }
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private getIssueWithSchemaRetry(run: RunRecord): IssueRecord | undefined {
    try {
      return this.db.getIssue(run.projectId, run.linearIssueId);
    } catch (error) {
      if (!isSqliteSchemaReadError(error)) {
        throw error;
      }
      this.db.assertSchemaReady();
      return this.db.getIssue(run.projectId, run.linearIssueId);
    }
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

function describeHeartbeatDetail(notification: { method: string; params: Record<string, unknown> }): string | undefined {
  if (notification.method === "item/started" || notification.method === "item/updated" || notification.method === "item/completed") {
    const item = notification.params.item;
    if (item && typeof item === "object") {
      const typed = item as Record<string, unknown>;
      if (typed.type === "commandExecution" && typeof typed.command === "string") {
        return `command ${trimHeartbeatDetail(typed.command)}`;
      }
      if (typed.type === "dynamicToolCall" && typeof typed.tool === "string") {
        return `tool ${trimHeartbeatDetail(typed.tool)}`;
      }
      if (typed.type === "mcpToolCall" && typeof typed.server === "string" && typeof typed.tool === "string") {
        return `tool ${trimHeartbeatDetail(`${typed.server}/${typed.tool}`)}`;
      }
    }
  }
  return notification.method;
}

function trimHeartbeatDetail(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength).trimEnd()}...`;
}
