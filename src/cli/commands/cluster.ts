import type { AppConfig } from "../../types.ts";
import type { CommandRunner, Output, ParsedArgs } from "../command-types.ts";
import { collectClusterHealth } from "../cluster-health.ts";
import type { CliDataAccess } from "../data.ts";
import { CliUsageError } from "../errors.ts";
import { formatJson } from "../formatters/json.ts";
import { writeOutput } from "../output.ts";
import { formatClusterHealth } from "../output.ts";

interface ClusterCommandParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  data: CliDataAccess;
  config: AppConfig;
  runCommand: CommandRunner;
}

export async function handleClusterCommand(params: ClusterCommandParams): Promise<number> {
  const subcommand = params.commandArgs[0];
  if (subcommand && subcommand !== "check" && subcommand !== "status") {
    throw new CliUsageError(`Unknown cluster command: ${subcommand}`, "cluster");
  }

  const report = await collectClusterHealth(params.config, params.data.db, params.runCommand);
  writeOutput(params.stdout, params.json ? formatJson(report) : formatClusterHealth(report));
  return report.ok ? 0 : 1;
}
