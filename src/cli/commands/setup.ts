import {
  getDefaultConfigPath,
  getDefaultRuntimeEnvPath,
  getDefaultServiceEnvPath,
  getSystemdUnitPath,
} from "../../runtime-paths.ts";
import { initializePatchRelayHome, installServiceUnits } from "../../install.ts";
import { loadConfig } from "../../config.ts";
import { parsePositiveIntegerFlag } from "../args.ts";
import type { CommandRunner, InteractiveRunner, Output, ParsedArgs } from "../command-types.ts";
import { CliUsageError } from "../errors.ts";
import { formatJson } from "../formatters/json.ts";
import { writeOutput } from "../output.ts";
import { installServiceCommands, restartServiceCommands, runServiceCommands, runSystemctl, tryManageService } from "../service-commands.ts";

interface SetupCommandParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  stderr: Output;
  runInteractive: InteractiveRunner;
  runCommand: CommandRunner;
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
    const serviceUnits = await installServiceUnits({ force: params.parsed.flags.get("force") === true });
    const serviceState = await tryManageService(params.runCommand, installServiceCommands());
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
            "",
            "PatchRelay public URLs:",
            `- Public base URL: ${result.publicBaseUrl}`,
            `- Webhook URL: ${result.webhookUrl}`,
            `- OAuth callback: ${result.oauthCallbackUrl}`,
            "",
            "Created with defaults:",
            "- Config file contains only machine-level essentials such as server.public_base_url",
            "- Database, logs, bind address, and worktree roots use built-in defaults",
            "- The system service is installed for you",
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
              ? "PatchRelay service is installed and reload-or-restart has been requested."
              : `PatchRelay service units were installed, but the service could not be started yet: ${serviceState.error}`,
            !serviceState.ok
              ? "This is expected until the required env vars and at least one valid repo workflow are in place. Rerun `patchrelay service restart` after updating config or env files."
              : undefined,
            "",
            "Next steps:",
            `1. Edit ${result.serviceEnvPath}`,
            "2. Paste your Linear OAuth client id and client secret into service.env and keep the generated webhook secret and token encryption key",
            "3. Paste LINEAR_WEBHOOK_SECRET from service.env into the Linear OAuth app webhook signing secret",
            "4. Run `patchrelay linear connect`",
            "5. Run `patchrelay linear sync`",
            "6. Run `patchrelay repo link <owner/repo> --workspace <workspace> --team <team>`",
            "7. Add the workflow files your repo needs, then run `patchrelay doctor`",
            "8. Run `patchrelay service status`",
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
    const result = await installServiceUnits({ force: params.parsed.flags.get("force") === true });
    const writeOnly = params.parsed.flags.get("write-only") === true;
    if (!writeOnly) {
      await runServiceCommands(params.runCommand, installServiceCommands());
    }
    writeOutput(
      params.stdout,
      params.json
        ? formatJson({ ...result, writeOnly })
        : [
            `Service unit: ${result.unitPath} (${result.serviceStatus})`,
            `Runtime env: ${result.runtimeEnvPath}`,
            `Service env: ${result.serviceEnvPath}`,
            `Config file: ${result.configPath}`,
            writeOnly
              ? "Service unit written. Start it with: sudo systemctl daemon-reload && sudo systemctl enable patchrelay.service && sudo systemctl reload-or-restart patchrelay.service"
              : "PatchRelay system service is installed and running.",
            "After package updates, run: patchrelay service restart",
          ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    writeOutput(params.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function handleRestartServiceCommand(params: SetupCommandParams): Promise<number> {
  const daemonReload = await runSystemctl(params.runCommand, ["daemon-reload"]);
  const restart = await runSystemctl(params.runCommand, ["reload-or-restart", "patchrelay.service"]);
  const ok = daemonReload.ok && restart.ok;
  writeOutput(
    ok ? params.stdout : params.stderr,
    params.json
      ? formatJson({
          service: "patchrelay",
          unit: "patchrelay.service",
          daemonReloaded: daemonReload.ok,
          restarted: restart.ok,
          errors: [
            ...(daemonReload.ok ? [] : [daemonReload.error]),
            ...(restart.ok ? [] : [restart.error]),
          ],
        })
      : [
          daemonReload.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${daemonReload.error}`,
          restart.ok ? "Restarted patchrelay.service" : `Restart failed: ${restart.error}`,
        ].join("\n") + "\n",
  );
  return ok ? 0 : 1;
}

function parseSystemctlShowOutput(raw: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    properties[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return properties;
}

async function readPatchRelayHealth(): Promise<
  | {
      reachable: true;
      ok: boolean;
      status: number;
    }
  | {
      reachable: false;
      error: string;
    }
> {
  try {
    const config = loadConfig(undefined, { profile: "doctor" });
    const host = config.server.bind === "0.0.0.0" ? "127.0.0.1" : config.server.bind;
    const response = await fetch(
      `http://${host}:${config.server.port}${config.server.healthPath}`,
      { signal: AbortSignal.timeout(2000) },
    );
    let ok = response.ok;
    try {
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.ok === "boolean") {
        ok = response.ok && body.ok;
      }
    } catch {
      ok = response.ok;
    }
    return {
      reachable: true,
      ok,
      status: response.status,
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleServiceCommand(params: SetupCommandParams): Promise<number> {
  if (params.commandArgs.length === 0) {
    throw new CliUsageError("patchrelay service requires a subcommand.", "service");
  }

  const subcommand = params.commandArgs[0];
  if (subcommand === "install") {
    return await handleInstallServiceCommand({
      ...params,
      commandArgs: params.commandArgs.slice(1),
    });
  }
  if (subcommand === "restart") {
    return await handleRestartServiceCommand({
      ...params,
      commandArgs: params.commandArgs.slice(1),
    });
  }
  if (subcommand === "status") {
    const result = await params.runCommand("sudo", [
      "systemctl",
      "show",
      "patchrelay.service",
      "--property=Id,LoadState,UnitFileState,ActiveState,SubState,FragmentPath,ExecMainPID",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to read patchrelay.service status.");
    }
    const properties = parseSystemctlShowOutput(result.stdout);
    const health = await readPatchRelayHealth();
    const payload = {
      service: "patchrelay",
      unit: "patchrelay.service",
      systemd: properties,
      health,
    };
    writeOutput(
      params.stdout,
      params.json
        ? formatJson(payload)
        : [
            "PatchRelay service",
            "",
            `Unit: ${properties.Id ?? "patchrelay.service"}`,
            `Load state: ${properties.LoadState ?? "unknown"}`,
            `Enabled: ${properties.UnitFileState ?? "unknown"}`,
            `Active: ${properties.ActiveState ?? "unknown"}${properties.SubState ? ` (${properties.SubState})` : ""}`,
            `Unit path: ${properties.FragmentPath || getSystemdUnitPath()}`,
            properties.ExecMainPID ? `Main PID: ${properties.ExecMainPID}` : undefined,
            health.reachable
              ? `Health: ${health.ok ? "ok" : "unhealthy"} (HTTP ${health.status})`
              : `Health: not reachable (${health.error})`,
          ]
            .filter(Boolean)
            .join("\n") + "\n",
    );
    return 0;
  }
  if (subcommand === "logs") {
    const lines = parsePositiveIntegerFlag(params.parsed.flags.get("lines"), "--lines") ?? 50;
    const result = await params.runCommand("sudo", [
      "journalctl",
      "-u",
      "patchrelay.service",
      "-n",
      String(lines),
      "--no-pager",
      "-o",
      "short-iso",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to read PatchRelay logs.");
    }
    const logs = result.stdout.split(/\r?\n/).filter(Boolean);
    writeOutput(
      params.stdout,
      params.json
        ? formatJson({
            service: "patchrelay",
            unit: "patchrelay.service",
            lines,
            logs,
          })
        : `${result.stdout}${result.stdout.endsWith("\n") || result.stdout.length === 0 ? "" : "\n"}`,
    );
    return 0;
  }

  throw new CliUsageError(`Unknown service command: ${subcommand}`, "service");
}

function normalizePublicBaseUrl(value: string): string {
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) ? value : `https://${value}`;
  const url = new URL(candidate);
  return url.origin;
}
