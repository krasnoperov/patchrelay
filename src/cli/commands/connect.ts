import type { AppConfig } from "../../types.ts";
import type { Output, ParsedArgs, RunCliOptions } from "../command-types.ts";
import { runConnectFlow, parseTimeoutSeconds } from "../connect-flow.ts";
import type { CliDataAccess } from "../data.ts";
import { formatJson } from "../formatters/json.ts";
import { openExternalUrl } from "../interactive.ts";
import { writeOutput } from "../output.ts";

interface ConnectCommandParams {
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  config: AppConfig;
  data: CliDataAccess;
  options?: RunCliOptions;
}

export async function handleConnectCommand(params: ConnectCommandParams): Promise<number> {
  return await runConnectFlow({
    config: params.config,
    data: params.data,
    stdout: params.stdout,
    noOpen: params.parsed.flags.get("no-open") === true,
    timeoutSeconds: parseTimeoutSeconds(params.parsed.flags.get("timeout"), "connect"),
    json: params.json,
    openExternal: params.options?.openExternal ?? openExternalUrl,
    ...(params.options?.connectPollIntervalMs !== undefined ? { connectPollIntervalMs: params.options.connectPollIntervalMs } : {}),
    ...(typeof params.parsed.flags.get("project") === "string" ? { projectId: String(params.parsed.flags.get("project")) } : {}),
  });
}

interface InstallationsCommandParams {
  json: boolean;
  stdout: Output;
  data: CliDataAccess;
}

export async function handleInstallationsCommand(params: InstallationsCommandParams): Promise<number> {
  const result = await params.data.listInstallations();
  if (params.json) {
    writeOutput(params.stdout, formatJson(result));
    return 0;
  }
  writeOutput(
    params.stdout,
    `${(result.installations.length > 0
      ? result.installations.map((item) => `${item.installation.id}  ${item.installation.workspaceName ?? item.installation.actorName ?? "-"}  projects=${item.linkedProjects.join(",") || "-"}`)
      : ["No installations found."]).join("\n")}\n`,
  );
  return 0;
}
