import type { IssueProjectionRecord } from "../types.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class IssueProjectionStore {
  constructor(private readonly connection: DatabaseConnection) {}

  upsertIssueProjection(params: {
    projectId: string;
    linearIssueId: string;
    issueKey?: string;
    title?: string;
    issueUrl?: string;
    currentLinearState?: string;
    lastWebhookAt?: string;
  }): void {
    this.connection
      .prepare(
        `
        INSERT INTO issue_projection (
          project_id, linear_issue_id, issue_key, title, issue_url, current_linear_state, last_webhook_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, linear_issue_id) DO UPDATE SET
          issue_key = COALESCE(excluded.issue_key, issue_projection.issue_key),
          title = COALESCE(excluded.title, issue_projection.title),
          issue_url = COALESCE(excluded.issue_url, issue_projection.issue_url),
          current_linear_state = COALESCE(excluded.current_linear_state, issue_projection.current_linear_state),
          last_webhook_at = COALESCE(excluded.last_webhook_at, issue_projection.last_webhook_at),
          updated_at = excluded.updated_at
        `,
      )
      .run(
        params.projectId,
        params.linearIssueId,
        params.issueKey ?? null,
        params.title ?? null,
        params.issueUrl ?? null,
        params.currentLinearState ?? null,
        params.lastWebhookAt ?? null,
        isoNow(),
      );
  }

  getIssueProjection(projectId: string, linearIssueId: string): IssueProjectionRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM issue_projection WHERE project_id = ? AND linear_issue_id = ?")
      .get(projectId, linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapIssueProjection(row) : undefined;
  }

  getIssueProjectionByKey(issueKey: string): IssueProjectionRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM issue_projection WHERE issue_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(issueKey) as Record<string, unknown> | undefined;
    return row ? mapIssueProjection(row) : undefined;
  }

  getIssueProjectionByLinearIssueId(linearIssueId: string): IssueProjectionRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM issue_projection WHERE linear_issue_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(linearIssueId) as Record<string, unknown> | undefined;
    return row ? mapIssueProjection(row) : undefined;
  }
}

function mapIssueProjection(row: Record<string, unknown>): IssueProjectionRecord {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    linearIssueId: String(row.linear_issue_id),
    ...(row.issue_key === null ? {} : { issueKey: String(row.issue_key) }),
    ...(row.title === null ? {} : { title: String(row.title) }),
    ...(row.issue_url === null ? {} : { issueUrl: String(row.issue_url) }),
    ...(row.current_linear_state === null ? {} : { currentLinearState: String(row.current_linear_state) }),
    ...(row.last_webhook_at === null ? {} : { lastWebhookAt: String(row.last_webhook_at) }),
    updatedAt: String(row.updated_at),
  };
}
