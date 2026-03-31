import { loadConfig } from "../../config.ts";
import type { AppConfig } from "../../types.ts";
import type { Output, ParsedArgs, RunCliOptions } from "../command-types.ts";
import { runConnectFlow, parseTimeoutSeconds } from "../connect-flow.ts";
import type { CliOperatorDataAccess } from "../operator-client.ts";
import { formatJson } from "../formatters/json.ts";
import { writeOutput } from "../output.ts";
import { openExternalUrl } from "../interactive.ts";

interface LinearCommandParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  options?: RunCliOptions;
}

export async function handleLinearCommand(params: LinearCommandParams): Promise<number> {
  const subcommand = params.commandArgs[0] ?? "list";
  const config = params.options?.config ?? loadConfig(undefined, { profile: "operator_cli" });
  const data = params.options?.data ?? (await createCliOperatorDataAccess(config));
  try {
    switch (subcommand) {
      case "connect":
        return await runConnectFlow({
          config,
          data,
          stdout: params.stdout,
          noOpen: params.parsed.flags.get("no-open") === true,
          timeoutSeconds: parseTimeoutSeconds(params.parsed.flags.get("timeout"), "linear connect"),
          json: params.json,
          openExternal: params.options?.openExternal ?? openExternalUrl,
          ...(params.options?.connectPollIntervalMs !== undefined ? { connectPollIntervalMs: params.options.connectPollIntervalMs } : {}),
        });
      case "list": {
        const result = await data.listLinearWorkspaces();
        writeOutput(
          params.stdout,
          params.json
            ? formatJson({ ok: true, ...result })
            : result.workspaces.length === 0
              ? "No Linear workspaces connected.\n"
              : `${result.workspaces.map((workspace) => {
                  const name = workspace.installation.workspaceKey ?? workspace.installation.workspaceName ?? `installation-${workspace.installation.id}`;
                  return `${name}  repos=${workspace.linkedRepos.length} teams=${workspace.teams.length} projects=${workspace.projects.length}`;
                }).join("\n")}\n`,
        );
        return 0;
      }
      case "sync": {
        const workspace = params.commandArgs[1];
        const result = await data.syncLinearWorkspace(workspace);
        writeOutput(
          params.stdout,
          params.json
            ? formatJson({ ok: true, ...result })
            : `Synced ${result.installation.workspaceKey ?? result.installation.workspaceName ?? result.installation.id}: ${result.teams.length} teams, ${result.projects.length} projects\n`,
        );
        return 0;
      }
      case "disconnect": {
        const workspace = params.commandArgs[1];
        if (!workspace) {
          throw new Error("patchrelay linear disconnect requires <workspace>.");
        }
        const result = await data.disconnectLinearWorkspace(workspace);
        writeOutput(
          params.stdout,
          params.json
            ? formatJson({ ok: true, ...result })
            : `Disconnected ${result.installation.workspaceKey ?? result.installation.workspaceName ?? result.installation.id}.\n`,
        );
        return 0;
      }
      default:
        throw new Error(`Unknown linear subcommand: ${subcommand}`);
    }
  } finally {
    if (!params.options?.data) {
      data.close();
    }
  }
}

async function createCliOperatorDataAccess(config: AppConfig): Promise<CliOperatorDataAccess> {
  const { CliOperatorApiClient } = await import("../operator-client.ts");
  return new CliOperatorApiClient(config);
}
