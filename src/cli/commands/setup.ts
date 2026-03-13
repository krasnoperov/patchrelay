import {
  getDefaultConfigPath,
  getDefaultRuntimeEnvPath,
  getDefaultServiceEnvPath,
  getSystemdUserPathUnitPath,
  getSystemdUserReloadUnitPath,
  getSystemdUserUnitPath,
} from "../../runtime-paths.ts";
import { initializePatchRelayHome, installUserServiceUnits } from "../../install.ts";
import type { InteractiveRunner, Output, ParsedArgs } from "../command-types.ts";
import { formatJson } from "../formatters/json.ts";
import { writeOutput } from "../output.ts";
import { installServiceCommands, restartServiceCommands, runServiceCommands, tryManageService } from "../service-commands.ts";

interface SetupCommandParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  stderr: Output;
  runInteractive: InteractiveRunner;
}

export async function handleInitCommand(params: SetupCommandParams): Promise<number> {
  try {
    const requestedPublicBaseUrl =
      typeof params.parsed.flags.get("public-base-url") === "string"
        ? String(params.parsed.flags.get("public-base-url"))
        : params.commandArgs[0];
    if (!requestedPublicBaseUrl) {
      throw new Error(
        [
          "patchrelay init requires <public-base-url>.",
          "PatchRelay must know the public HTTPS origin that Linear will call for the webhook and OAuth callback.",
          "Example: patchrelay init https://patchrelay.example.com",
        ].join("\n"),
      );
    }
    const publicBaseUrl = normalizePublicBaseUrl(requestedPublicBaseUrl);
    const result = await initializePatchRelayHome({
      force: params.parsed.flags.get("force") === true,
      publicBaseUrl,
    });
    const serviceUnits = await installUserServiceUnits({ force: params.parsed.flags.get("force") === true });
    const serviceState = await tryManageService(params.runInteractive, installServiceCommands());
    writeOutput(
      params.stdout,
      params.json
        ? formatJson({ ...result, serviceUnits, serviceState })
        : [
            `Config directory: ${result.configDir}`,
            `Runtime env: ${result.runtimeEnvPath} (${result.runtimeEnvStatus})`,
            `Service env: ${result.serviceEnvPath} (${result.serviceEnvStatus})`,
            `Config file: ${result.configPath} (${result.configStatus})`,
            `State directory: ${result.stateDir}`,
            `Data directory: ${result.dataDir}`,
            `Service unit: ${serviceUnits.unitPath} (${serviceUnits.serviceStatus})`,
            `Reload unit: ${serviceUnits.reloadUnitPath} (${serviceUnits.reloadStatus})`,
            `Watcher unit: ${serviceUnits.pathUnitPath} (${serviceUnits.pathStatus})`,
            "",
            "PatchRelay public URLs:",
            `- Public base URL: ${result.publicBaseUrl}`,
            `- Webhook URL: ${result.webhookUrl}`,
            `- OAuth callback: ${result.oauthCallbackUrl}`,
            "",
            "Created with defaults:",
            `- Config file contains only machine-level essentials such as server.public_base_url`,
            `- Database, logs, bind address, and worktree roots use built-in defaults`,
            `- The user service and config watcher are installed for you`,
            "",
            "Register the app in Linear:",
            "- Open Linear Settings > API > Applications",
            "- Create an OAuth app for PatchRelay",
            "- Choose actor `app`",
            "- Choose scopes `read`, `write`, `app:assignable`, `app:mentionable`",
            `- Add redirect URI ${result.oauthCallbackUrl}`,
            `- Add webhook URL ${result.webhookUrl}`,
            "- Enable webhook categories for issue events, comment events, agent session events, permission changes, and inbox/app-user notifications",
            "",
            result.configStatus === "skipped"
              ? `Config file was skipped, so make sure ${result.configPath} still has server.public_base_url: ${result.publicBaseUrl}`
              : `Config file already includes server.public_base_url: ${result.publicBaseUrl}`,
            "",
            "Service status:",
            serviceState.ok
              ? "PatchRelay service and config watcher are installed and reload-or-restart has been requested."
              : `PatchRelay service units were installed, but the service could not be started yet: ${serviceState.error}`,
            !serviceState.ok
              ? "This is expected until the required env vars and at least one valid project workflow are in place. The watcher will retry when config or env files change."
              : undefined,
            "",
            "Next steps:",
            `1. Edit ${result.serviceEnvPath}`,
            "2. Paste your Linear OAuth client id and client secret into service.env and keep the generated webhook secret and token encryption key",
            "3. Paste LINEAR_WEBHOOK_SECRET from service.env into the Linear OAuth app webhook signing secret",
            "4. Run `patchrelay project apply <id> <repo-path>`",
            "5. Edit the generated project workflows if you want custom state names or workflow files, then add those workflow files to the repo",
            "6. Run `patchrelay doctor`",
          ]
            .filter(Boolean)
            .join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    writeOutput(params.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function handleInstallServiceCommand(params: SetupCommandParams): Promise<number> {
  try {
    const result = await installUserServiceUnits({ force: params.parsed.flags.get("force") === true });
    const writeOnly = params.parsed.flags.get("write-only") === true;
    if (!writeOnly) {
      await runServiceCommands(params.runInteractive, installServiceCommands());
    }
    writeOutput(
      params.stdout,
      params.json
        ? formatJson({ ...result, writeOnly })
        : [
            `Service unit: ${result.unitPath} (${result.serviceStatus})`,
            `Reload unit: ${result.reloadUnitPath} (${result.reloadStatus})`,
            `Watcher unit: ${result.pathUnitPath} (${result.pathStatus})`,
            `Runtime env: ${result.runtimeEnvPath}`,
            `Service env: ${result.serviceEnvPath}`,
            `Config file: ${result.configPath}`,
            writeOnly
              ? "Service units written. Start them with: systemctl --user daemon-reload && systemctl --user enable --now patchrelay.path && systemctl --user enable patchrelay.service && systemctl --user reload-or-restart patchrelay.service"
              : "PatchRelay user service and config watcher are installed and running.",
            "After package updates, run: patchrelay restart-service",
          ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    writeOutput(params.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function handleRestartServiceCommand(params: SetupCommandParams): Promise<number> {
  try {
    await runServiceCommands(params.runInteractive, restartServiceCommands());
    writeOutput(
      params.stdout,
      params.json
        ? formatJson({
            service: "patchrelay",
            unitPath: getSystemdUserUnitPath(),
            reloadUnitPath: getSystemdUserReloadUnitPath(),
            pathUnitPath: getSystemdUserPathUnitPath(),
            runtimeEnvPath: getDefaultRuntimeEnvPath(),
            serviceEnvPath: getDefaultServiceEnvPath(),
            configPath: getDefaultConfigPath(),
            restarted: true,
          })
        : "Reloaded systemd user units and reload-or-restart was requested for PatchRelay.\n",
    );
    return 0;
  } catch (error) {
    writeOutput(params.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function normalizePublicBaseUrl(value: string): string {
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) ? value : `https://${value}`;
  const url = new URL(candidate);
  return url.origin;
}
