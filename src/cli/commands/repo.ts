import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../../config.ts";
import { ensureRepositoryProjectSettings, removeRepositoryFromConfig, upsertRepositoryInConfig } from "../../install.ts";
import { defaultLocalRepoPath, ensureLocalRepository, normalizeGitHubRepo } from "../../repository-linking.ts";
import type { AppConfig } from "../../types.ts";
import { ensureDir, execCommand } from "../../utils.ts";
import { parseCsvFlag } from "../args.ts";
import type { CommandRunner, Output, ParsedArgs, RunCliOptions } from "../command-types.ts";
import type { CliOperatorDataAccess } from "../operator-client.ts";
import { formatJson } from "../formatters/json.ts";
import { writeOutput } from "../output.ts";
import { restartServiceCommands, tryManageService } from "../service-commands.ts";

interface RepoCommandParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  runCommand: CommandRunner;
  options?: RunCliOptions;
}

export async function handleRepoCommand(params: RepoCommandParams): Promise<number> {
  const subcommand = params.commandArgs[0] ?? "list";
  switch (subcommand) {
    case "list":
      return await handleRepoList(params);
    case "show":
      return await handleRepoShow(params);
    case "link":
      return await handleRepoLink(params);
    case "unlink":
      return await handleRepoUnlink(params);
    case "sync":
      return await handleRepoSync(params);
    default:
      throw new Error(`Unknown repo subcommand: ${subcommand}`);
  }
}

async function handleRepoList(params: RepoCommandParams): Promise<number> {
  const config = params.options?.config ?? loadConfig(undefined, { profile: "doctor" });
  writeOutput(
    params.stdout,
    params.json
      ? formatJson({ ok: true, repositories: config.repositories })
      : config.repositories.length === 0
        ? "No repositories linked.\n"
        : `${config.repositories.map((repository) => `${repository.githubRepo}  ${repository.localPath}`).join("\n")}\n`,
  );
  return 0;
}

async function handleRepoShow(params: RepoCommandParams): Promise<number> {
  const githubRepo = params.commandArgs[1];
  if (!githubRepo) {
    throw new Error("patchrelay repo show requires <github-repo>.");
  }
  const normalized = normalizeGitHubRepo(githubRepo);
  const config = params.options?.config ?? loadConfig(undefined, { profile: "doctor" });
  const repository = config.repositories.find((entry) => entry.githubRepo === normalized);
  if (!repository) {
    throw new Error(`Repository not linked: ${normalized}`);
  }
  writeOutput(
    params.stdout,
    params.json
      ? formatJson({ ok: true, repository })
      : [
          `Repository: ${repository.githubRepo}`,
          `Path: ${repository.localPath}`,
          `Workspace: ${repository.workspace ?? "-"}`,
          `Linear teams: ${repository.linearTeamIds.join(", ") || "-"}`,
          `Linear projects: ${repository.linearProjectIds.join(", ") || "-"}`,
          `Issue key prefixes: ${repository.issueKeyPrefixes.join(", ") || "-"}`,
        ].join("\n") + "\n",
  );
  return 0;
}

async function handleRepoLink(params: RepoCommandParams): Promise<number> {
  const githubRepoArg = params.commandArgs[1];
  if (!githubRepoArg) {
    throw new Error("patchrelay repo link requires <github-repo>.");
  }
  const githubRepo = normalizeGitHubRepo(githubRepoArg);
  const workspaceArg = typeof params.parsed.flags.get("workspace") === "string" ? String(params.parsed.flags.get("workspace")) : undefined;
  if (!workspaceArg) {
    throw new Error("patchrelay repo link requires --workspace <workspace>.");
  }
  const teamQueries = parseCsvFlag(params.parsed.flags.get("team"));
  if (teamQueries.length === 0) {
    throw new Error("patchrelay repo link requires --team <key-or-id>[,...].");
  }
  const projectQueries = parseCsvFlag(params.parsed.flags.get("project"));
  const explicitPrefixes = parseCsvFlag(params.parsed.flags.get("prefix"));

  const config = params.options?.config ?? loadConfig(undefined, { profile: "operator_cli" });
  const data = params.options?.data ?? (await createCliOperatorDataAccess(config));
  try {
    const syncResult = await data.syncLinearWorkspace(workspaceArg);
    const installation = syncResult.installation;
    const teams = resolveTeams(syncResult.teams, teamQueries);
    const projects = resolveProjects(syncResult.projects, projectQueries);
    const derivedPrefixes = explicitPrefixes.length > 0
      ? explicitPrefixes
      : teams.map((team) => team.key).filter((value): value is string => Boolean(value));

    const localPathFlag = typeof params.parsed.flags.get("path") === "string" ? String(params.parsed.flags.get("path")) : undefined;
    const localPath = localPathFlag ? localPathFlag : defaultLocalRepoPath(config.repos.root, githubRepo);
    const repoState = await ensureLocalRepository({ config, githubRepo, localPath });
    await ensureRepositoryProjectSettings(repoState.localPath);

    const saveResult = await upsertRepositoryInConfig({
      githubRepo,
      localPath: repoState.localPath,
      workspace: installation.workspaceKey ?? installation.workspaceName ?? workspaceArg,
      linearTeamIds: teams.map((team) => team.id),
      linearProjectIds: projects.map((project) => project.id),
      issueKeyPrefixes: derivedPrefixes,
    });

    const { PatchRelayDatabase } = await import("../../db.ts");
    await ensureDir(dirname(config.database.path));
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    try {
      db.runMigrations();
      db.linearInstallations.setProjectInstallation(githubRepo, installation.id);
    } finally {
      db.connection.close();
    }

    const serviceState = await tryManageService(params.runCommand, restartServiceCommands());
    if (!serviceState.ok) {
      throw new Error(`Repository was linked, but PatchRelay could not be reloaded: ${serviceState.error}`);
    }

    writeOutput(
      params.stdout,
      params.json
        ? formatJson({
            ok: true,
            repository: saveResult.repository,
            clone: repoState,
            installation,
            teams,
            projects,
          })
        : [
            `${saveResult.status === "created" ? "Linked" : saveResult.status === "updated" ? "Updated" : "Verified"} ${githubRepo}`,
            `Path: ${repoState.localPath}${repoState.reused ? " (reused)" : " (cloned)"}`,
            `Workspace: ${installation.workspaceKey ?? installation.workspaceName ?? installation.id}`,
            `Linear teams: ${teams.map((team) => team.key ?? team.name ?? team.id).join(", ")}`,
            `Linear projects: ${projects.map((project) => project.name ?? project.id).join(", ") || "-"}`,
            `Issue key prefixes: ${derivedPrefixes.join(", ") || "-"}`,
          ].join("\n") + "\n",
    );
    return 0;
  } finally {
    if (!params.options?.data) {
      data.close();
    }
  }
}

async function handleRepoUnlink(params: RepoCommandParams): Promise<number> {
  const githubRepoArg = params.commandArgs[1];
  if (!githubRepoArg) {
    throw new Error("patchrelay repo unlink requires <github-repo>.");
  }
  const githubRepo = normalizeGitHubRepo(githubRepoArg);
  const config = params.options?.config ?? loadConfig(undefined, { profile: "doctor" });
  const result = await removeRepositoryFromConfig({ githubRepo });

  const { PatchRelayDatabase } = await import("../../db.ts");
  await ensureDir(dirname(config.database.path));
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  try {
    db.runMigrations();
    db.linearInstallations.unlinkProjectInstallation(githubRepo);
  } finally {
    db.connection.close();
  }

  const serviceState = await tryManageService(params.runCommand, restartServiceCommands());
  if (!serviceState.ok) {
    throw new Error(`Repository was unlinked, but PatchRelay could not be reloaded: ${serviceState.error}`);
  }

  writeOutput(
    params.stdout,
    params.json
      ? formatJson({ ok: true, githubRepo, removed: result.removed })
      : result.removed
        ? `Unlinked ${githubRepo}.\n`
        : `Repository was not linked: ${githubRepo}\n`,
  );
  return 0;
}

async function handleRepoSync(params: RepoCommandParams): Promise<number> {
  const githubRepoArg = params.commandArgs[1];
  const config = params.options?.config ?? loadConfig(undefined, { profile: "doctor" });
  const repositories = githubRepoArg
    ? config.repositories.filter((repository) => repository.githubRepo === normalizeGitHubRepo(githubRepoArg))
    : config.repositories;

  const results: Array<{ githubRepo: string; localPath: string; fetched: boolean }> = [];
  for (const repository of repositories) {
    if (!existsSync(repository.localPath)) {
      await ensureLocalRepository({ config, githubRepo: repository.githubRepo, localPath: repository.localPath });
      results.push({ githubRepo: repository.githubRepo, localPath: repository.localPath, fetched: false });
      continue;
    }
    await execCommand(config.runner.gitBin, ["-C", repository.localPath, "fetch", "origin"], { timeoutMs: 300_000 });
    results.push({ githubRepo: repository.githubRepo, localPath: repository.localPath, fetched: true });
  }

  writeOutput(
    params.stdout,
    params.json
      ? formatJson({ ok: true, repositories: results })
      : `${results.map((result) => `${result.githubRepo}  ${result.fetched ? "fetched" : "cloned"}  ${result.localPath}`).join("\n")}\n`,
  );
  return 0;
}

function resolveTeams(
  teams: Array<{ id: string; key?: string; name?: string }>,
  queries: string[],
): Array<{ id: string; key?: string; name?: string }> {
  return queries.map((query) => {
    const normalized = query.trim().toLowerCase();
    const team = teams.find((entry) =>
      entry.id.toLowerCase() === normalized
      || entry.key?.trim().toLowerCase() === normalized
      || entry.name?.trim().toLowerCase() === normalized
    );
    if (!team) {
      throw new Error(`Linear team not found: ${query}`);
    }
    return team;
  });
}

function resolveProjects(
  projects: Array<{ id: string; name?: string; teamIds: string[] }>,
  queries: string[],
): Array<{ id: string; name?: string; teamIds: string[] }> {
  return queries.map((query) => {
    const normalized = query.trim().toLowerCase();
    const project = projects.find((entry) =>
      entry.id.toLowerCase() === normalized
      || entry.name?.trim().toLowerCase() === normalized
    );
    if (!project) {
      throw new Error(`Linear project not found: ${query}`);
    }
    return project;
  });
}

async function createCliOperatorDataAccess(config: AppConfig): Promise<CliOperatorDataAccess> {
  const { CliOperatorApiClient } = await import("../operator-client.ts");
  return new CliOperatorApiClient(config);
}
