import type { OperatorFeedEvent } from "../operator-feed.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class OperatorFeedStore {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly maxRows = 5000,
  ) {}

  save(event: Omit<OperatorFeedEvent, "id"> & { id?: number }): OperatorFeedEvent {
    const at = event.at ?? isoNow();
    const result = this.connection.prepare(
      `
      INSERT INTO operator_feed_events (at, level, kind, summary, detail, issue_key, project_id, stage, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      at,
      event.level,
      event.kind,
      event.summary,
      event.detail ?? null,
      event.issueKey ?? null,
      event.projectId ?? null,
      event.stage ?? null,
      event.status ?? null,
    );
    this.prune();
    const stored = this.connection.prepare("SELECT * FROM operator_feed_events WHERE id = ?").get(Number(result.lastInsertRowid));
    return mapOperatorFeedEvent(stored!);
  }

  list(options?: { limit?: number; afterId?: number; issueKey?: string; projectId?: string }): OperatorFeedEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options?.afterId !== undefined) {
      clauses.push("id > ?");
      params.push(options.afterId);
    }
    if (options?.issueKey) {
      clauses.push("issue_key = ?");
      params.push(options.issueKey);
    }
    if (options?.projectId) {
      clauses.push("project_id = ?");
      params.push(options.projectId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options?.limit ?? 50;
    const rows = this.connection.prepare(
      `
      SELECT *
      FROM operator_feed_events
      ${where}
      ORDER BY id DESC
      LIMIT ?
      `,
    ).all(...params, limit);

    return rows
      .map((row) => mapOperatorFeedEvent(row))
      .reverse();
  }

  private prune(): void {
    this.connection.prepare(
      `
      DELETE FROM operator_feed_events
      WHERE id NOT IN (
        SELECT id
        FROM operator_feed_events
        ORDER BY id DESC
        LIMIT ?
      )
      `,
    ).run(this.maxRows);
  }
}

function mapOperatorFeedEvent(row: Record<string, unknown>): OperatorFeedEvent {
  return {
    id: Number(row.id),
    at: String(row.at),
    level: row.level as OperatorFeedEvent["level"],
    kind: row.kind as OperatorFeedEvent["kind"],
    summary: String(row.summary),
    ...(row.detail === null ? {} : { detail: String(row.detail) }),
    ...(row.issue_key === null ? {} : { issueKey: String(row.issue_key) }),
    ...(row.project_id === null ? {} : { projectId: String(row.project_id) }),
    ...(row.stage === null ? {} : { stage: row.stage as OperatorFeedEvent["stage"] }),
    ...(row.status === null ? {} : { status: String(row.status) }),
  };
}
