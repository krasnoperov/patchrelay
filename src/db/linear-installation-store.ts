import type {
  LinearInstallationRecord,
  OAuthStateRecord,
  ProjectInstallationRecord,
} from "../types.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class LinearInstallationStore {
  constructor(private readonly connection: DatabaseConnection) {}

  upsertLinearInstallation(params: {
    workspaceId?: string;
    workspaceName?: string;
    workspaceKey?: string;
    actorId?: string;
    actorName?: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext?: string | null;
    scopesJson: string;
    tokenType?: string;
    expiresAt?: string | null;
  }): LinearInstallationRecord {
    const now = isoNow();
    const existing = params.workspaceId
      ? (this.connection
          .prepare("SELECT id FROM linear_installations WHERE workspace_id = ? ORDER BY id DESC LIMIT 1")
          .get(params.workspaceId) as { id: number } | undefined)
      : undefined;

    if (existing) {
      this.connection
        .prepare(
          `
          UPDATE linear_installations
          SET workspace_name = COALESCE(?, workspace_name),
              workspace_key = COALESCE(?, workspace_key),
              actor_id = COALESCE(?, actor_id),
              actor_name = COALESCE(?, actor_name),
              access_token_ciphertext = ?,
              refresh_token_ciphertext = COALESCE(?, refresh_token_ciphertext),
              scopes_json = ?,
              token_type = COALESCE(?, token_type),
              expires_at = COALESCE(?, expires_at),
              updated_at = ?
          WHERE id = ?
          `,
        )
        .run(
          params.workspaceName ?? null,
          params.workspaceKey ?? null,
          params.actorId ?? null,
          params.actorName ?? null,
          params.accessTokenCiphertext,
          params.refreshTokenCiphertext ?? null,
          params.scopesJson,
          params.tokenType ?? null,
          params.expiresAt ?? null,
          now,
          existing.id,
        );
      return this.getLinearInstallation(existing.id)!;
    }

    const result = this.connection
      .prepare(
        `
        INSERT INTO linear_installations (
          workspace_id, workspace_name, workspace_key, actor_id, actor_name,
          access_token_ciphertext, refresh_token_ciphertext, scopes_json, token_type, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        params.workspaceId ?? null,
        params.workspaceName ?? null,
        params.workspaceKey ?? null,
        params.actorId ?? null,
        params.actorName ?? null,
        params.accessTokenCiphertext,
        params.refreshTokenCiphertext ?? null,
        params.scopesJson,
        params.tokenType ?? null,
        params.expiresAt ?? null,
        now,
        now,
      );
    return this.getLinearInstallation(Number(result.lastInsertRowid))!;
  }

  saveLinearInstallation(params: {
    workspaceId?: string;
    workspaceName?: string;
    workspaceKey?: string;
    actorId?: string;
    actorName?: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext?: string | null;
    scopesJson: string;
    tokenType?: string;
    expiresAt?: string | null;
  }): LinearInstallationRecord {
    return this.upsertLinearInstallation(params);
  }

  updateLinearInstallationTokens(
    id: number,
    params: {
      accessTokenCiphertext: string;
      refreshTokenCiphertext?: string | null;
      scopesJson?: string;
      tokenType?: string | null;
      expiresAt?: string | null;
    },
  ): LinearInstallationRecord | undefined {
    this.connection
      .prepare(
        `
        UPDATE linear_installations
        SET access_token_ciphertext = ?,
            refresh_token_ciphertext = COALESCE(?, refresh_token_ciphertext),
            scopes_json = COALESCE(?, scopes_json),
            token_type = COALESCE(?, token_type),
            expires_at = COALESCE(?, expires_at),
            updated_at = ?
        WHERE id = ?
        `,
      )
      .run(
        params.accessTokenCiphertext,
        params.refreshTokenCiphertext ?? null,
        params.scopesJson ?? null,
        params.tokenType ?? null,
        params.expiresAt ?? null,
        isoNow(),
        id,
      );
    return this.getLinearInstallation(id);
  }

  getLinearInstallation(id: number): LinearInstallationRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM linear_installations WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapLinearInstallation(row) : undefined;
  }

  listLinearInstallations(): LinearInstallationRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM linear_installations ORDER BY updated_at DESC, id DESC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => mapLinearInstallation(row));
  }

  linkProjectInstallation(projectId: string, installationId: number): ProjectInstallationRecord {
    const now = isoNow();
    this.connection
      .prepare(
        `
        INSERT INTO project_installations (project_id, installation_id, linked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET installation_id = excluded.installation_id, linked_at = excluded.linked_at
        `,
      )
      .run(projectId, installationId, now);
    return this.getProjectInstallation(projectId)!;
  }

  setProjectInstallation(projectId: string, installationId: number): ProjectInstallationRecord {
    return this.linkProjectInstallation(projectId, installationId);
  }

  getProjectInstallation(projectId: string): ProjectInstallationRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM project_installations WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? mapProjectInstallation(row) : undefined;
  }

  listProjectInstallations(): ProjectInstallationRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM project_installations ORDER BY project_id")
      .all() as Record<string, unknown>[];
    return rows.map((row) => mapProjectInstallation(row));
  }

  unlinkProjectInstallation(projectId: string): void {
    this.connection.prepare("DELETE FROM project_installations WHERE project_id = ?").run(projectId);
  }

  getLinearInstallationForProject(projectId: string): LinearInstallationRecord | undefined {
    const row = this.connection
      .prepare(
        `
        SELECT li.*
        FROM linear_installations li
        INNER JOIN project_installations pi ON pi.installation_id = li.id
        WHERE pi.project_id = ?
        `,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? mapLinearInstallation(row) : undefined;
  }

  createOAuthState(params: {
    provider: "linear";
    state: string;
    projectId?: string;
    redirectUri: string;
    actor: "user" | "app";
  }): OAuthStateRecord {
    const now = isoNow();
    const result = this.connection
      .prepare(
        `
        INSERT INTO oauth_states (provider, state, project_id, redirect_uri, actor, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `,
      )
      .run(params.provider, params.state, params.projectId ?? null, params.redirectUri, params.actor, now);
    return this.getOAuthStateById(Number(result.lastInsertRowid))!;
  }

  getOAuthState(state: string): OAuthStateRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM oauth_states WHERE state = ? ORDER BY id DESC LIMIT 1")
      .get(state) as Record<string, unknown> | undefined;
    return row ? mapOAuthState(row) : undefined;
  }

  finalizeOAuthState(params: {
    state: string;
    status: "completed" | "failed";
    installationId?: number;
    errorMessage?: string;
  }): OAuthStateRecord | undefined {
    const now = isoNow();
    this.connection
      .prepare(
        `
        UPDATE oauth_states
        SET status = ?, consumed_at = ?, installation_id = COALESCE(?, installation_id), error_message = COALESCE(?, error_message)
        WHERE state = ?
        `,
      )
      .run(params.status, now, params.installationId ?? null, params.errorMessage ?? null, params.state);
    return this.getOAuthState(params.state);
  }

  private getOAuthStateById(id: number): OAuthStateRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM oauth_states WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapOAuthState(row) : undefined;
  }
}

function mapLinearInstallation(row: Record<string, unknown>): LinearInstallationRecord {
  return {
    id: Number(row.id),
    provider: "linear",
    ...(row.workspace_id === null ? {} : { workspaceId: String(row.workspace_id) }),
    ...(row.workspace_name === null ? {} : { workspaceName: String(row.workspace_name) }),
    ...(row.workspace_key === null ? {} : { workspaceKey: String(row.workspace_key) }),
    ...(row.actor_id === null ? {} : { actorId: String(row.actor_id) }),
    ...(row.actor_name === null ? {} : { actorName: String(row.actor_name) }),
    accessTokenCiphertext: String(row.access_token_ciphertext),
    ...(row.refresh_token_ciphertext === null ? {} : { refreshTokenCiphertext: String(row.refresh_token_ciphertext) }),
    scopesJson: String(row.scopes_json),
    ...(row.token_type === null ? {} : { tokenType: String(row.token_type) }),
    ...(row.expires_at === null ? {} : { expiresAt: String(row.expires_at) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapProjectInstallation(row: Record<string, unknown>): ProjectInstallationRecord {
  return {
    projectId: String(row.project_id),
    installationId: Number(row.installation_id),
    linkedAt: String(row.linked_at),
  };
}

function mapOAuthState(row: Record<string, unknown>): OAuthStateRecord {
  return {
    id: Number(row.id),
    provider: "linear",
    state: String(row.state),
    ...(row.project_id === null ? {} : { projectId: String(row.project_id) }),
    redirectUri: String(row.redirect_uri),
    actor: row.actor as OAuthStateRecord["actor"],
    createdAt: String(row.created_at),
    status: (row.status as OAuthStateRecord["status"]) ?? "pending",
    ...(row.consumed_at === null ? {} : { consumedAt: String(row.consumed_at) }),
    ...(row.installation_id === null ? {} : { installationId: Number(row.installation_id) }),
    ...(row.error_message === null ? {} : { errorMessage: String(row.error_message) }),
  };
}
