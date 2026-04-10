import { SqliteStore } from "../../db/sqlite-store.ts";
import { TERMINAL_STATUSES, type QueueEntry, type QueueEntryDetail, type QueueWatchSnapshot } from "../../types.ts";
import type { StewardConfig } from "../../config.ts";
import type { ParsedArgs, Output } from "../types.ts";
import { UsageError } from "../types.ts";
import { parseIntegerFlag } from "../args.ts";
import { formatJson, writeOutput } from "../output.ts";
import { loadRepoConfigById, resolveRepoId, fetchLocalJson } from "../system.ts";
import { buildQueueSummary } from "../../watch/dashboard-model.ts";

async function readQueueSnapshot(config: StewardConfig, eventLimit: number): Promise<{ source: "service" | "database"; snapshot: QueueWatchSnapshot }> {
  try {
    const query = new URLSearchParams({ eventLimit: String(eventLimit) });
    const snapshot = await fetchLocalJson<QueueWatchSnapshot>(config.repoId, `/queue/watch?${query.toString()}`);
    return { source: "service", snapshot };
  } catch {
    const store = new SqliteStore(config.database.path);
    try {
      const entries = store.listAll(config.repoId);
      return {
        source: "database",
        snapshot: {
          repoId: config.repoId,
          repoFullName: config.repoFullName,
          baseBranch: config.baseBranch,
          summary: buildQueueSummary(entries),
          runtime: {
            tickInProgress: false,
            lastTickStartedAt: null,
            lastTickCompletedAt: null,
            lastTickOutcome: "idle",
            lastTickError: null,
          },
          queueBlock: null,
          entries,
          recentEvents: store.listRecentEvents(config.repoId, { limit: eventLimit }),
        },
      };
    } finally {
      store.close();
    }
  }
}

function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : null;
}

export function formatQueueStatusText(source: "service" | "database", snapshot: QueueWatchSnapshot): string {
  return [
    `Repo: ${snapshot.repoId} (${snapshot.repoFullName})`,
    `Source: ${source}`,
    `Base branch: ${snapshot.baseBranch}`,
    `Active entries: ${snapshot.summary.active}`,
    `Queued: ${snapshot.summary.queued}  preparing: ${snapshot.summary.preparingHead}  validating: ${snapshot.summary.validating}  merging: ${snapshot.summary.merging}`,
    `Merged: ${snapshot.summary.merged}  evicted: ${snapshot.summary.evicted}  dequeued: ${snapshot.summary.dequeued}`,
    snapshot.summary.headPrNumber ? `Head PR: #${snapshot.summary.headPrNumber}` : "Head PR: none",
    ...(snapshot.runtime.lastTickOutcome === "failed"
      ? [
        "Last tick: failed",
        ...(firstLine(snapshot.runtime.lastTickError) ? [`Last error: ${firstLine(snapshot.runtime.lastTickError)}`] : []),
      ]
      : []),
    ...(snapshot.queueBlock
      ? [
        `Queue blocked: ${snapshot.queueBlock.reason} on ${snapshot.queueBlock.baseBranch}${snapshot.queueBlock.baseSha ? ` @ ${snapshot.queueBlock.baseSha.slice(0, 8)}` : ""}`,
        `Base failures: ${snapshot.queueBlock.failingChecks.length > 0 ? snapshot.queueBlock.failingChecks.map((check) => check.name).join(", ") : "(none)"}`,
        ...(snapshot.queueBlock.pendingChecks.length > 0
          ? [`Base pending: ${snapshot.queueBlock.pendingChecks.map((check) => check.name).join(", ")}`]
          : []),
      ]
      : []),
    "",
    "Entries:",
    ...(snapshot.entries.length > 0
      ? snapshot.entries.map((entry) => `- #${entry.prNumber} ${entry.status} pos=${entry.position} branch=${entry.branch}`)
      : ["- (none)"]),
  ].join("\n") + "\n";
}

function findEntryForInspect(store: SqliteStore, repoId: string, options: { entryId?: string; prNumber?: number }): QueueEntry | undefined {
  if (options.entryId) {
    return store.getEntry(options.entryId);
  }
  if (options.prNumber !== undefined) {
    const matches = store.listAll(repoId).filter((entry) => entry.prNumber === options.prNumber);
    matches.sort((left, right) => {
      const leftActive = TERMINAL_STATUSES.includes(left.status) ? 0 : 1;
      const rightActive = TERMINAL_STATUSES.includes(right.status) ? 0 : 1;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return right.position - left.position;
    });
    return matches[0];
  }
  return undefined;
}

function readQueueEntryDetail(config: StewardConfig, options: { entryId?: string; prNumber?: number; eventLimit: number }): QueueEntryDetail | undefined {
  const store = new SqliteStore(config.database.path);
  try {
    const entry = findEntryForInspect(store, config.repoId, options);
    if (!entry || entry.repoId !== config.repoId) {
      return undefined;
    }
    return {
      entry,
      events: store.listEvents(entry.id, { limit: options.eventLimit }),
      incidents: store.listIncidents(entry.id),
    };
  } finally {
    store.close();
  }
}

export async function handleQueue(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const subcommand = parsed.positionals[1];
  if (!subcommand) {
    throw new UsageError("merge-steward queue requires a subcommand.", "queue");
  }

  if (subcommand === "watch") {
    throw new UsageError("`merge-steward queue watch` was replaced by `merge-steward dashboard [--repo <id>] [--pr <number>]`.", "queue");
  }

  if (subcommand === "dashboard") {
    const { handleDashboard } = await import("./dashboard.ts");
    return await handleDashboard(parsed);
  }

  const repoId = resolveRepoId(parsed, 2, "queue");
  const { config } = loadRepoConfigById(repoId);

  if (subcommand === "status") {
    const eventLimit = parseIntegerFlag(parsed.flags.get("events"), "--events") ?? 20;
    const { source, snapshot } = await readQueueSnapshot(config, eventLimit);
    const payload = { source, ...snapshot };
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(payload));
      return 0;
    }
    writeOutput(stdout, formatQueueStatusText(source, snapshot));
    return 0;
  }

  if (subcommand === "show") {
    const entryId = typeof parsed.flags.get("entry") === "string" ? String(parsed.flags.get("entry")) : undefined;
    const prNumber = parseIntegerFlag(parsed.flags.get("pr"), "--pr");
    if (!entryId && prNumber === undefined) {
      throw new UsageError("merge-steward queue show requires --entry <id> or --pr <number>.", "queue");
    }
    const detail = readQueueEntryDetail(config, {
      ...(entryId ? { entryId } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
      eventLimit: parseIntegerFlag(parsed.flags.get("events"), "--events") ?? 100,
    });
    if (!detail) {
      throw new Error(`Queue entry not found for repo ${repoId}.`);
    }
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        repoId,
        ...detail,
      }));
      return 0;
    }
    writeOutput(
      stdout,
      [
        `Repo: ${repoId}`,
        `Entry: ${detail.entry.id}`,
        `PR: #${detail.entry.prNumber}`,
        `Status: ${detail.entry.status}`,
        `Position: ${detail.entry.position}`,
        `Branch: ${detail.entry.branch}`,
        `Head SHA: ${detail.entry.headSha}`,
        detail.entry.baseSha ? `Base SHA: ${detail.entry.baseSha}` : undefined,
        detail.entry.issueKey ? `Issue: ${detail.entry.issueKey}` : undefined,
        "",
        "Events:",
        ...(detail.events.length > 0
          ? detail.events.map((event) => `- ${event.at} ${event.fromStatus ?? "(start)"} -> ${event.toStatus}${event.detail ? ` (${event.detail})` : ""}`)
          : ["- (none)"]),
        "",
        "Incidents:",
        ...(detail.incidents.length > 0
          ? detail.incidents.map((incident) => `- ${incident.at} ${incident.failureClass} (${incident.outcome})`)
          : ["- (none)"]),
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
    return 0;
  }

  if (subcommand === "reconcile") {
    try {
      const result = await fetchLocalJson<{ ok: boolean; started: boolean; runtime: QueueWatchSnapshot["runtime"] }>(
        config.repoId,
        "/queue/reconcile",
        { method: "POST" },
      );
      if (parsed.flags.get("json") === true) {
        writeOutput(stdout, formatJson({ repoId, ...result }));
      } else {
        writeOutput(
          stdout,
          [
            `Repo: ${repoId}`,
            result.started ? "Reconcile started." : "Reconcile request accepted; a tick was already in progress.",
            `Last outcome: ${result.runtime.lastTickOutcome}`,
          ].join("\n") + "\n",
        );
      }
      return 0;
    } catch (error) {
      throw new Error(`Unable to reach the local merge-steward service for ${repoId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new UsageError(`Unknown queue command: ${subcommand}`, "queue");
}
