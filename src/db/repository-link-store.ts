import type {
  LinearCatalogProjectRecord,
  LinearCatalogTeamRecord,
  RepositoryLinkRecord,
} from "../linear-types.ts";
import { isoNow, type DatabaseConnection } from "./shared.ts";

export class RepositoryLinkStore {
  constructor(private readonly connection: DatabaseConnection) {}

  upsertRepositoryLink(params: {
    githubRepo: string;
    localPath: string;
    installationId: number;
    linearTeamIds: string[];
    linearProjectIds?: string[];
    issueKeyPrefixes?: string[];
  }): RepositoryLinkRecord {
    const now = isoNow();
    this.connection
      .prepare(
        `
        INSERT INTO repository_links (
          github_repo, local_path, installation_id, linear_team_ids_json, linear_project_ids_json, issue_key_prefixes_json, linked_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(github_repo) DO UPDATE SET
          local_path = excluded.local_path,
          installation_id = excluded.installation_id,
          linear_team_ids_json = excluded.linear_team_ids_json,
          linear_project_ids_json = excluded.linear_project_ids_json,
          issue_key_prefixes_json = excluded.issue_key_prefixes_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        params.githubRepo,
        params.localPath,
        params.installationId,
        JSON.stringify(params.linearTeamIds),
        JSON.stringify(params.linearProjectIds ?? []),
        JSON.stringify(params.issueKeyPrefixes ?? []),
        now,
        now,
      );
    return this.getRepositoryLink(params.githubRepo)!;
  }

  getRepositoryLink(githubRepo: string): RepositoryLinkRecord | undefined {
    const row = this.connection
      .prepare("SELECT * FROM repository_links WHERE github_repo = ?")
      .get(githubRepo) as Record<string, unknown> | undefined;
    return row ? mapRepositoryLink(row) : undefined;
  }

  listRepositoryLinks(): RepositoryLinkRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM repository_links ORDER BY github_repo")
      .all() as Record<string, unknown>[];
    return rows.map(mapRepositoryLink);
  }

  deleteRepositoryLink(githubRepo: string): void {
    this.connection.prepare("DELETE FROM repository_links WHERE github_repo = ?").run(githubRepo);
  }

  replaceCatalog(params: {
    installationId: number;
    teams: Array<{ id: string; key?: string; name?: string }>;
    projects: Array<{ id: string; name?: string; teamIds: string[] }>;
  }): void {
    const now = isoNow();
    this.connection.prepare("DELETE FROM linear_catalog_teams WHERE installation_id = ?").run(params.installationId);
    this.connection.prepare("DELETE FROM linear_catalog_projects WHERE installation_id = ?").run(params.installationId);

    const teamStmt = this.connection.prepare(
      `
      INSERT INTO linear_catalog_teams (installation_id, team_id, team_key, team_name, active, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      `,
    );
    for (const team of params.teams) {
      teamStmt.run(params.installationId, team.id, team.key ?? null, team.name ?? null, now);
    }

    const projectStmt = this.connection.prepare(
      `
      INSERT INTO linear_catalog_projects (installation_id, project_id, project_name, team_ids_json, active, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      `,
    );
    for (const project of params.projects) {
      projectStmt.run(params.installationId, project.id, project.name ?? null, JSON.stringify(project.teamIds), now);
    }
  }

  listCatalogTeams(installationId: number): LinearCatalogTeamRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM linear_catalog_teams WHERE installation_id = ? ORDER BY COALESCE(team_key, team_name, team_id)")
      .all(installationId) as Record<string, unknown>[];
    return rows.map(mapCatalogTeam);
  }

  listCatalogProjects(installationId: number): LinearCatalogProjectRecord[] {
    const rows = this.connection
      .prepare("SELECT * FROM linear_catalog_projects WHERE installation_id = ? ORDER BY COALESCE(project_name, project_id)")
      .all(installationId) as Record<string, unknown>[];
    return rows.map(mapCatalogProject);
  }
}

function mapRepositoryLink(row: Record<string, unknown>): RepositoryLinkRecord {
  return {
    githubRepo: String(row.github_repo),
    localPath: String(row.local_path),
    installationId: Number(row.installation_id),
    linearTeamIdsJson: String(row.linear_team_ids_json ?? "[]"),
    linearProjectIdsJson: String(row.linear_project_ids_json ?? "[]"),
    issueKeyPrefixesJson: String(row.issue_key_prefixes_json ?? "[]"),
    linkedAt: String(row.linked_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCatalogTeam(row: Record<string, unknown>): LinearCatalogTeamRecord {
  return {
    installationId: Number(row.installation_id),
    teamId: String(row.team_id),
    ...(row.team_key === null ? {} : { key: String(row.team_key) }),
    ...(row.team_name === null ? {} : { name: String(row.team_name) }),
    active: Number(row.active ?? 0) !== 0,
    updatedAt: String(row.updated_at),
  };
}

function mapCatalogProject(row: Record<string, unknown>): LinearCatalogProjectRecord {
  return {
    installationId: Number(row.installation_id),
    projectId: String(row.project_id),
    ...(row.project_name === null ? {} : { name: String(row.project_name) }),
    teamIdsJson: String(row.team_ids_json ?? "[]"),
    active: Number(row.active ?? 0) !== 0,
    updatedAt: String(row.updated_at),
  };
}
