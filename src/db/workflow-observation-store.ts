import type { WorkflowObservationRecord, WorkflowObservationSource } from "../db-types.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export interface AppendWorkflowObservationParams {
  projectId: string;
  subjectId: string;
  source: WorkflowObservationSource;
  type: string;
  payloadJson?: string | undefined;
  dedupeKey?: string | undefined;
  observedAt?: string | undefined;
}

export class WorkflowObservationStore {
  constructor(
    private readonly connection: DatabaseConnection,
    private readonly mapWorkflowObservationRow: (row: Record<string, unknown>) => WorkflowObservationRecord,
  ) {}

  appendObservation(params: AppendWorkflowObservationParams): WorkflowObservationRecord {
    if (params.dedupeKey) {
      const existing = this.connection.prepare(`
        SELECT * FROM workflow_observations
        WHERE project_id = ? AND subject_id = ? AND source = ? AND dedupe_key = ?
        ORDER BY id DESC LIMIT 1
      `).get(params.projectId, params.subjectId, params.source, params.dedupeKey) as Record<string, unknown> | undefined;
      if (existing) {
        return this.mapWorkflowObservationRow(existing);
      }
    }

    const result = this.connection.prepare(`
      INSERT INTO workflow_observations (
        project_id, subject_id, source, type, payload_json, dedupe_key, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.projectId,
      params.subjectId,
      params.source,
      params.type,
      params.payloadJson ?? null,
      params.dedupeKey ?? null,
      params.observedAt ?? isoNow(),
    );
    return this.getObservation(Number(result.lastInsertRowid))!;
  }

  getObservation(id: number): WorkflowObservationRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM workflow_observations WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapWorkflowObservationRow(row) : undefined;
  }

  listObservations(projectId: string, subjectId: string): WorkflowObservationRecord[] {
    const rows = this.connection.prepare(`
      SELECT * FROM workflow_observations
      WHERE project_id = ? AND subject_id = ?
      ORDER BY id
    `).all(projectId, subjectId) as Array<Record<string, unknown>>;
    return rows.map(this.mapWorkflowObservationRow);
  }

  listRecentObservations(params: {
    projectId?: string | undefined;
    observedAfter?: string | undefined;
    limit?: number | undefined;
  } = {}): WorkflowObservationRecord[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (params.projectId) {
      conditions.push("project_id = ?");
      values.push(params.projectId);
    }
    if (params.observedAfter) {
      conditions.push("observed_at >= ?");
      values.push(params.observedAfter);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit ?? 250;
    const rows = this.connection.prepare(`
      SELECT * FROM workflow_observations
      ${where}
      ORDER BY id DESC
      LIMIT ?
    `).all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map(this.mapWorkflowObservationRow);
  }
}
