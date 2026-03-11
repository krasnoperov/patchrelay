import type { QueuedTurnInputRecord, ThreadEventRecord } from "../types.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class StageEventStore {
  constructor(private readonly connection: DatabaseConnection) {}

  saveThreadEvent(params: { stageRunId: number; threadId: string; turnId?: string; method: string; eventJson: string }): number {
    const result = this.connection
      .prepare(
        `
        INSERT INTO thread_events (stage_run_id, thread_id, turn_id, method, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(params.stageRunId, params.threadId, params.turnId ?? null, params.method, params.eventJson, isoNow());
    return Number(result.lastInsertRowid);
  }

  listThreadEvents(stageRunId: number): ThreadEventRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM thread_events WHERE stage_run_id = ? ORDER BY id")
      .all(stageRunId) as Record<string, unknown>[];
    return rows.map((row) => mapThreadEvent(row));
  }

  enqueueTurnInput(params: { stageRunId: number; threadId?: string; turnId?: string; source: string; body: string }): number {
    const result = this.connection
      .prepare(
        `
        INSERT INTO queued_turn_inputs (stage_run_id, thread_id, turn_id, source, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(params.stageRunId, params.threadId ?? null, params.turnId ?? null, params.source, params.body, isoNow());
    return Number(result.lastInsertRowid);
  }

  listPendingTurnInputs(stageRunId: number): QueuedTurnInputRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM queued_turn_inputs WHERE stage_run_id = ? AND delivered_at IS NULL ORDER BY id")
      .all(stageRunId) as Record<string, unknown>[];
    return rows.map((row) => mapQueuedTurnInput(row));
  }

  markTurnInputDelivered(id: number): void {
    this.connection.prepare("UPDATE queued_turn_inputs SET delivered_at = ? WHERE id = ?").run(isoNow(), id);
  }

  setPendingTurnInputRouting(id: number, threadId: string, turnId: string): void {
    this.connection.prepare("UPDATE queued_turn_inputs SET thread_id = ?, turn_id = ? WHERE id = ?").run(threadId, turnId, id);
  }
}

function mapThreadEvent(row: Record<string, unknown>): ThreadEventRecord {
  return {
    id: Number(row.id),
    stageRunId: Number(row.stage_run_id),
    threadId: String(row.thread_id),
    ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
    method: String(row.method),
    eventJson: String(row.event_json),
    createdAt: String(row.created_at),
  };
}

function mapQueuedTurnInput(row: Record<string, unknown>): QueuedTurnInputRecord {
  return {
    id: Number(row.id),
    stageRunId: Number(row.stage_run_id),
    ...(row.thread_id === null ? {} : { threadId: String(row.thread_id) }),
    ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
    source: String(row.source),
    body: String(row.body),
    ...(row.delivered_at === null ? {} : { deliveredAt: String(row.delivered_at) }),
    createdAt: String(row.created_at),
  };
}
