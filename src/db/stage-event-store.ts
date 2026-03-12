import type { ThreadEventRecord } from "../types.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class StageEventStore {
  constructor(private readonly connection: DatabaseConnection) {}

  saveThreadEvent(params: { stageRunId: number; threadId: string; turnId?: string; method: string; eventJson: string }): number {
    const result = this.connection
      .prepare(
        `
        INSERT INTO run_thread_events (run_lease_id, thread_id, turn_id, method, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(params.stageRunId, params.threadId, params.turnId ?? null, params.method, params.eventJson, isoNow());
    return Number(result.lastInsertRowid);
  }

  listThreadEvents(stageRunId: number): ThreadEventRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM run_thread_events WHERE run_lease_id = ? ORDER BY id")
      .all(stageRunId) as Record<string, unknown>[];
    return rows.map((row) => mapThreadEvent(row));
  }
}

function mapThreadEvent(row: Record<string, unknown>): ThreadEventRecord {
  return {
    id: Number(row.id),
    stageRunId: Number(row.run_lease_id),
    threadId: String(row.thread_id),
    ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
    method: String(row.method),
    eventJson: String(row.event_json),
    createdAt: String(row.created_at),
  };
}
