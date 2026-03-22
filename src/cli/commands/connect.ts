import type { AppConfig } from "../../types.ts";
import type { Output, ParsedArgs, RunCliOptions } from "../command-types.ts";
import { runConnectFlow, parseTimeoutSeconds } from "../connect-flow.ts";
import type { CliOperatorDataAccess } from "../operator-client.ts";
import { formatJson } from "../formatters/json.ts";
import { openExternalUrl } from "../interactive.ts";
import { writeOutput } from "../output.ts";

interface ConnectCommandParams {
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  config: AppConfig;
  data: CliOperatorDataAccess;
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
  data: CliOperatorDataAccess;
  config: AppConfig;
}

export async function handleInstallationsCommand(params: InstallationsCommandParams): Promise<number> {
  const result = await params.data.listInstallations();
  if (params.json) {
    writeOutput(params.stdout, formatJson({
      ...result,
      installations: result.installations.map((item) => ({
        ...item,
        projects: item.linkedProjects.map((id) => {
          const p = params.config.projects.find((proj) => proj.id === id);
          return p ? { id: p.id, repoPath: p.repoPath, issueKeyPrefixes: p.issueKeyPrefixes, linearTeamIds: p.linearTeamIds } : { id };
        }),
      })),
    }));
    return 0;
  }
  if (result.installations.length === 0) {
    writeOutput(params.stdout, "No installations found.\n");
    return 0;
  }
  const lines: string[] = [];
  for (const item of result.installations) {
    const label = item.installation.workspaceName ?? item.installation.actorName ?? "-";
    lines.push(`${item.installation.id}  ${label}  projects=${item.linkedProjects.join(",") || "-"}`);
    for (const projectId of item.linkedProjects) {
      const p = params.config.projects.find((proj) => proj.id === projectId);
      if (!p) continue;
      const routing = [
        ...(p.issueKeyPrefixes.length > 0 ? [`prefixes=${p.issueKeyPrefixes.join(",")}`] : []),
        ...(p.linearTeamIds.length > 0 ? [`teams=${p.linearTeamIds.join(",")}`] : []),
      ].join(" ") || "no routing";
      lines.push(`     ${projectId}  ${p.repoPath}  ${routing}`);
    }
  }
  writeOutput(params.stdout, `${lines.join("\n")}\n`);
  return 0;
}
