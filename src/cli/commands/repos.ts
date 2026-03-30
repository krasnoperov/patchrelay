import { loadConfig } from "../../config.ts";
import { installServiceUnits, upsertProjectInConfig } from "../../install.ts";
import type { AppConfig } from "../../types.ts";
import { hasHelpFlag, parseCsvFlag } from "../args.ts";
import type { CommandRunner, InteractiveRunner, Output, ParsedArgs, RunCliOptions } from "../command-types.ts";
import { runConnectFlow, parseTimeoutSeconds } from "../connect-flow.ts";
import { CliUsageError } from "../errors.ts";
import { formatJson } from "../formatters/json.ts";
import { reposHelpText } from "../help.ts";
import type { CliOperatorDataAccess } from "../operator-client.ts";
import { writeOutput } from "../output.ts";
import { installServiceCommands, tryManageService } from "../service-commands.ts";

interface AttachCommandParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  runInteractive: InteractiveRunner;
  runCommand: CommandRunner;
  options?: RunCliOptions;
}

interface ReposCommandParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
}

export async function handleReposCommand(params: ReposCommandParams): Promise<number> {
  if (hasHelpFlag(params.parsed)) {
    writeOutput(params.stdout, `${reposHelpText()}\n`);
    return 0;
  }

  const config = loadConfig(undefined, { profile: "service" });
  const repoId = params.commandArgs[0];

  if (!repoId) {
    const repos = config.projects.map((project) => ({
      id: project.id,
      repoPath: project.repoPath,
      issueKeyPrefixes: project.issueKeyPrefixes,
      linearTeamIds: project.linearTeamIds,
    }));
    writeOutput(
      params.stdout,
      params.json
        ? formatJson({ repos })
        : repos.length === 0
          ? "No repos configured yet.\n"
          : `${repos.map((repo) => `${repo.id}  ${repo.repoPath}`).join("\n")}\n`,
    );
    return 0;
  }

  const repo = config.projects.find((project) => project.id === repoId);
  if (!repo) {
    throw new Error(`Repo not found: ${repoId}`);
  }
  const payload = {
    id: repo.id,
    repoPath: repo.repoPath,
    issueKeyPrefixes: repo.issueKeyPrefixes,
    linearTeamIds: repo.linearTeamIds,
  };
  writeOutput(
    params.stdout,
    params.json
      ? formatJson(payload)
      : [
          `Repo: ${repo.id}`,
          `Path: ${repo.repoPath}`,
          `Issue key prefixes: ${repo.issueKeyPrefixes.join(", ") || "-"}`,
          `Linear team ids: ${repo.linearTeamIds.join(", ") || "-"}`,
        ].join("\n") + "\n",
  );
  return 0;
}

export async function handleAttachCommand(params: AttachCommandParams): Promise<number> {
  if (hasHelpFlag(params.parsed)) {
    writeOutput(params.stdout, `${reposHelpText()}\n`);
    return 0;
  }

  const repoId = params.commandArgs[0];
  const positionalRepoPath = params.commandArgs[1];
  const flaggedRepoPath =
    typeof params.parsed.flags.get("path") === "string"
      ? String(params.parsed.flags.get("path"))
      : undefined;
  if (!repoId) {
    throw new CliUsageError("patchrelay attach requires <id>.", "repos");
  }
  if (positionalRepoPath && flaggedRepoPath) {
    throw new CliUsageError("patchrelay attach accepts either [path] or --path <path>, not both.", "repos");
  }
  const repoPath = flaggedRepoPath ?? positionalRepoPath ?? process.cwd();

  const result = await upsertProjectInConfig({
    id: repoId,
    repoPath,
    issueKeyPrefixes: parseCsvFlag(params.parsed.flags.get("prefix")),
    linearTeamIds: parseCsvFlag(params.parsed.flags.get("team")),
  });
  const serviceUnits = await installServiceUnits();
  const noAuth = params.parsed.flags.get("no-auth") === true;

  const lines = [
    `Config file: ${result.configPath}`,
    `${result.status === "created" ? "Attached" : result.status === "updated" ? "Updated" : "Verified"} repo ${result.project.id} for ${result.project.repoPath}`,
    result.project.issueKeyPrefixes.length > 0 ? `Issue key prefixes: ${result.project.issueKeyPrefixes.join(", ")}` : undefined,
    result.project.linearTeamIds.length > 0 ? `Linear team ids: ${result.project.linearTeamIds.join(", ")}` : undefined,
    `Service unit: ${serviceUnits.unitPath} (${serviceUnits.serviceStatus})`,
  ].filter(Boolean) as string[];

  let fullConfig: AppConfig;
  try {
    fullConfig = loadConfig(undefined, { profile: "doctor" });
  } catch (error) {
    if (params.json) {
      writeOutput(
        params.stdout,
        formatJson({
          ...result,
          serviceUnits,
          readiness: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          auth: {
            attempted: false,
            skipped: "missing_env",
          },
        }),
      );
      return 0;
    }
    lines.push(`Linear auth was skipped: ${error instanceof Error ? error.message : String(error)}`);
    lines.push("Finish the required env vars and rerun `patchrelay attach`.");
    writeOutput(params.stdout, `${lines.join("\n")}\n`);
    return 0;
  }

  const { runPreflight } = await import("../../preflight.ts");
  const report = await runPreflight(fullConfig, { skipServiceCheck: true });
  const failedChecks = report.checks.filter((check) => check.status === "fail");
  if (failedChecks.length > 0) {
    if (params.json) {
      writeOutput(
        params.stdout,
        formatJson({
          ...result,
          serviceUnits,
          readiness: report,
          auth: {
            attempted: false,
            skipped: "preflight_failed",
          },
        }),
      );
      return 0;
    }
    lines.push("Linear auth was skipped because PatchRelay is not ready yet:");
    lines.push(...failedChecks.map((check) => `- [${check.scope}] ${check.message}`));
    lines.push("Fix the failures above and rerun `patchrelay attach`.");
    writeOutput(params.stdout, `${lines.join("\n")}\n`);
    return 0;
  }

  const serviceState = await tryManageService(params.runCommand, installServiceCommands());
  if (!serviceState.ok) {
    throw new Error(`Repo was saved, but PatchRelay could not be reloaded: ${serviceState.error}`);
  }

  const cliData = params.options?.data ?? (await createCliOperatorDataAccess(fullConfig));
  try {
    if (params.json) {
      const authResult = noAuth ? undefined : await cliData.connect(repoId);
      writeOutput(
        params.stdout,
        formatJson({
          ...result,
          serviceUnits,
          readiness: report,
          serviceReloaded: true,
          ...(noAuth
            ? {
                auth: {
                  attempted: false,
                  skipped: "no_auth",
                },
              }
            : {
                auth: {
                  attempted: true,
                  result: authResult,
                },
              }),
        }),
      );
      return 0;
    }

    if (noAuth) {
      lines.push("Repo attached and PatchRelay was reloaded.");
      lines.push(`Next: patchrelay connect --repo ${result.project.id}`);
      writeOutput(params.stdout, `${lines.join("\n")}\n`);
      return 0;
    }

    writeOutput(params.stdout, `${lines.join("\n")}\n`);
    return await runConnectFlow({
      config: fullConfig,
      data: cliData,
      stdout: params.stdout,
      noOpen: params.parsed.flags.get("no-open") === true,
      timeoutSeconds: parseTimeoutSeconds(params.parsed.flags.get("timeout"), "attach"),
      projectId: repoId,
      ...(params.options?.openExternal ? { openExternal: params.options.openExternal } : {}),
      ...(params.options?.connectPollIntervalMs !== undefined ? { connectPollIntervalMs: params.options.connectPollIntervalMs } : {}),
    });
  } finally {
    if (!params.options?.data) {
      cliData.close();
    }
  }
}

async function createCliOperatorDataAccess(config: AppConfig): Promise<CliOperatorDataAccess> {
  const { CliOperatorApiClient } = await import("../operator-client.ts");
  return new CliOperatorApiClient(config);
}
