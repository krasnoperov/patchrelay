import { loadConfig } from "../../config.ts";
import { installServiceUnits, upsertProjectInConfig } from "../../install.ts";
import type { AppConfig } from "../../types.ts";
import { hasHelpFlag, parseCsvFlag } from "../args.ts";
import type { InteractiveRunner, Output, ParsedArgs, RunCliOptions } from "../command-types.ts";
import { runConnectFlow, parseTimeoutSeconds } from "../connect-flow.ts";
import { CliUsageError } from "../errors.ts";
import { formatJson } from "../formatters/json.ts";
import { projectHelpText } from "../help.ts";
import type { CliOperatorDataAccess } from "../operator-client.ts";
import { writeOutput } from "../output.ts";
import { installServiceCommands, tryManageService } from "../service-commands.ts";

interface ProjectCommandParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  stderr: Output;
  runInteractive: InteractiveRunner;
  options?: RunCliOptions;
}

export async function handleProjectCommand(params: ProjectCommandParams): Promise<number> {
  if (hasHelpFlag(params.parsed)) {
    writeOutput(params.stdout, `${projectHelpText()}\n`);
    return 0;
  }

  if (params.commandArgs.length === 0) {
    throw new CliUsageError("patchrelay project requires a subcommand.", "project");
  }

  const subcommand = params.commandArgs[0];
  if (subcommand !== "apply") {
    throw new CliUsageError(`Unknown project command: ${subcommand}`, "project");
  }

  const projectId = params.commandArgs[1];
  const repoPath = params.commandArgs[2];
  if (!projectId || !repoPath) {
    throw new CliUsageError("patchrelay project apply requires <id> and <repo-path>.", "project");
  }

  const result = await upsertProjectInConfig({
    id: projectId,
    repoPath,
    issueKeyPrefixes: parseCsvFlag(params.parsed.flags.get("issue-prefix")),
    linearTeamIds: parseCsvFlag(params.parsed.flags.get("team-id")),
  });
  const serviceUnits = await installServiceUnits();
  const noConnect = params.parsed.flags.get("no-connect") === true;

  const lines = [
    `Config file: ${result.configPath}`,
    `${result.status === "created" ? "Created" : result.status === "updated" ? "Updated" : "Verified"} project ${result.project.id} for ${result.project.repoPath}`,
    result.project.issueKeyPrefixes.length > 0 ? `Issue key prefixes: ${result.project.issueKeyPrefixes.join(", ")}` : undefined,
    result.project.linearTeamIds.length > 0 ? `Linear team ids: ${result.project.linearTeamIds.join(", ")}` : undefined,
    `Service unit: ${serviceUnits.unitPath} (${serviceUnits.serviceStatus})`,
    `Watcher unit: ${serviceUnits.pathUnitPath} (${serviceUnits.pathStatus})`,
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
          connect: {
            attempted: false,
            skipped: "missing_env",
          },
        }),
      );
      return 0;
    }
    lines.push(`Linear connect was skipped: ${error instanceof Error ? error.message : String(error)}`);
    lines.push("Finish the required env vars and rerun `patchrelay project apply`.");
    writeOutput(params.stdout, `${lines.join("\n")}\n`);
    return 0;
  }

  const { runPreflight } = await import("../../preflight.ts");
  const report = await runPreflight(fullConfig);
  const failedChecks = report.checks.filter((check) => check.status === "fail");
  if (failedChecks.length > 0) {
    if (params.json) {
      writeOutput(
        params.stdout,
        formatJson({
          ...result,
          serviceUnits,
          readiness: report,
          connect: {
            attempted: false,
            skipped: "preflight_failed",
          },
        }),
      );
      return 0;
    }
    lines.push("Linear connect was skipped because PatchRelay is not ready yet:");
    lines.push(...failedChecks.map((check) => `- [${check.scope}] ${check.message}`));
    lines.push("Fix the failures above and rerun `patchrelay project apply`.");
    writeOutput(params.stdout, `${lines.join("\n")}\n`);
    return 0;
  }

  const serviceState = await tryManageService(params.runInteractive, installServiceCommands());
  if (!serviceState.ok) {
    throw new Error(`Project was saved, but PatchRelay could not be reloaded: ${serviceState.error}`);
  }

  const cliData = params.options?.data ?? (await createCliOperatorDataAccess(fullConfig));
  try {
    if (params.json) {
      const connectResult = noConnect ? undefined : await cliData.connect(projectId);
      writeOutput(
        params.stdout,
        formatJson({
          ...result,
          serviceUnits,
          readiness: report,
          serviceReloaded: true,
          ...(noConnect
            ? {
                connect: {
                  attempted: false,
                  skipped: "no_connect",
                },
              }
            : {
                connect: {
                  attempted: true,
                  result: connectResult,
                },
              }),
        }),
      );
      return 0;
    }

    if (noConnect) {
      lines.push("Project saved and PatchRelay was reloaded.");
      lines.push(`Next: patchrelay connect --project ${result.project.id}`);
      writeOutput(params.stdout, `${lines.join("\n")}\n`);
      return 0;
    }

    writeOutput(params.stdout, `${lines.join("\n")}\n`);
    return await runConnectFlow({
      config: fullConfig,
      data: cliData,
      stdout: params.stdout,
      noOpen: params.parsed.flags.get("no-open") === true,
      timeoutSeconds: parseTimeoutSeconds(params.parsed.flags.get("timeout"), "project apply"),
      projectId,
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
