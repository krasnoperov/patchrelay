import type { RunReportRecord } from "../types.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class RunReportStore {
  constructor(private readonly connection: DatabaseConnection) {}

  saveRunReport(params: { runLeaseId: number; summaryJson?: string; reportJson?: string }): void {
    const now = isoNow();
    this.connection
      .prepare(
        `
        INSERT INTO run_reports (run_lease_id, summary_json, report_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_lease_id) DO UPDATE SET
          summary_json = excluded.summary_json,
          report_json = excluded.report_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(params.runLeaseId, params.summaryJson ?? null, params.reportJson ?? null, now, now);
  }

  getRunReport(runLeaseId: number): RunReportRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM run_reports WHERE run_lease_id = ?").get(runLeaseId) as Record<string, unknown> | undefined;
    return row ? mapRunReport(row) : undefined;
  }
}

function mapRunReport(row: Record<string, unknown>): RunReportRecord {
  return {
    runLeaseId: Number(row.run_lease_id),
    ...(row.summary_json === null ? {} : { summaryJson: String(row.summary_json) }),
    ...(row.report_json === null ? {} : { reportJson: String(row.report_json) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
