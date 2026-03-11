import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../config.ts";
import { initializePatchRelayHome, installUserServiceUnits, upsertProjectInConfig } from "../install.ts";
import { runPreflight } from "../preflight.ts";
import {
  getDefaultConfigPath,
  getDefaultEnvPath,
  getSystemdUserPathUnitPath,
  getSystemdUserReloadUnitPath,
  getSystemdUserUnitPath,
} from "../runtime-paths.ts";
import { CliDataAccess } from "./data.ts";
import { formatJson } from "./formatters/json.ts";
import { formatEvents, formatInspect, formatList, formatLive, formatOpen, formatReport, formatRetry, formatWorktree } from "./formatters/text.ts";
import type { AppConfig, WorkflowStage } from "../types.ts";

type Output = Pick<NodeJS.WriteStream, "write">;
type ServiceCommand = { command: string; args: string[] };

const KNOWN_COMMANDS = new Set([
  "serve",
  "inspect",
  "live",
  "report",
  "events",
  "worktree",
  "open",
  "retry",
  "list",
  "doctor",
  "init",
  "project",
  "connect",
  "installations",
  "install-service",
  "restart-service",
  "help",
]);

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

type InteractiveRunner = (command: string, args: string[]) => Promise<number>;

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const trimmed = value.slice(2);
    const [name, inline] = trimmed.split("=", 2);
    if (!name) {
      continue;
    }
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
      continue;
    }

    flags.set(name, true);
  }

  return { positionals, flags };
}

function helpText(): string {
  return [
    "PatchRelay",
    "",
    "patchrelay is a local service and CLI that connects Linear issue delegation to Codex worktrees on your machine.",
    "",
    "Usage:",
    "  patchrelay <command> [args] [flags]",
    "  patchrelay <issueKey>                 # shorthand for `patchrelay inspect <issueKey>`",
    "",
    "First-time setup:",
    "  1. patchrelay init <public-https-url>",
    "  2. Fill in ~/.config/patchrelay/.env",
    "  3. patchrelay project apply <id> <repo-path>",
    "  4. Add workflow files to that repo if they are not there yet, then rerun `project apply`",
    "  5. patchrelay doctor",
    "",
    "Why init needs the public URL:",
    "  Linear must reach PatchRelay at a public HTTPS origin for both the webhook endpoint",
    "  and the OAuth callback. `patchrelay init` writes that origin to `server.public_base_url`.",
    "",
    "Default behavior:",
    "  PatchRelay already defaults the local bind address, database path, log path, worktree",
    "  root, workflow filenames, workflow statuses, and Codex runner settings. In the normal",
    "  case you only need the public URL, the required secrets, and at least one project.",
    "  `patchrelay init` installs the user service and config watcher, and `project apply`",
    "  upserts the repo config and reuses or starts the Linear connection flow.",
    "",
    "Commands:",
    "  init <public-base-url> [--force] [--json]                Bootstrap the machine-level PatchRelay home",
    "  project apply <id> <repo-path> [--issue-prefix <prefixes>] [--team-id <ids>] [--no-connect] [--timeout <seconds>] [--json]",
    "                                                           Upsert one local repository and connect it to Linear when ready",
    "  doctor [--json]                                          Check secrets, paths, workflows, git, and codex",
    "  install-service [--force] [--write-only] [--json]       Reinstall the systemd user service and watcher",
    "  restart-service [--json]                                Reload-or-restart the systemd user service",
    "  connect [--project <projectId>] [--no-open] [--timeout <seconds>] [--json]",
    "                                                           Advanced: start or reuse a Linear installation directly",
    "  installations [--json]                                  Show connected Linear installations",
    "  serve                                                   Run the local PatchRelay service",
    "  inspect <issueKey>                                      Show the latest known issue state",
    "  live <issueKey> [--watch] [--json]                      Show the active run status",
    "  report <issueKey> [--stage <stage>] [--stage-run <id>] [--json]",
    "                                                           Show finished stage reports",
    "  events <issueKey> [--stage-run <id>] [--method <name>] [--follow] [--json]",
    "                                                           Show raw thread events",
    "  worktree <issueKey> [--cd] [--json]                     Print the issue worktree path",
    "  open <issueKey> [--print] [--json]                      Open Codex in the issue worktree",
    "  retry <issueKey> [--stage <stage>] [--reason <text>] [--json]",
    "                                                           Requeue a stage",
    "  list [--active] [--failed] [--project <projectId>] [--json]",
    "                                                           List tracked issues",
  ].join("\n");
}

function normalizePublicBaseUrl(value: string): string {
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) ? value : `https://${value}`;
  const url = new URL(candidate);
  return url.origin;
}

function getStageFlag(value: string | boolean | undefined): WorkflowStage | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "development" || value === "review" || value === "deploy" || value === "cleanup") {
    return value;
  }
  throw new Error(`Unsupported stage: ${value}`);
}

function parseCsvFlag(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function writeOutput(stream: Output, text: string): void {
  stream.write(text);
}

function formatDoctor(report: Awaited<ReturnType<typeof runPreflight>>): string {
  const lines = ["PatchRelay doctor", ""];

  for (const check of report.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${marker} [${check.scope}] ${check.message}`);
  }

  lines.push("");
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}

function buildOpenCommand(config: AppConfig, worktreePath: string, resumeThreadId?: string): { command: string; args: string[] } {
  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  if (resumeThreadId) {
    args.push("resume", "-C", worktreePath, resumeThreadId);
  } else {
    args.push("-C", worktreePath);
  }

  return {
    command: config.runner.codex.bin,
    args,
  };
}

async function runInteractiveCommand(command: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

async function openExternalUrl(url: string): Promise<boolean> {
  const candidates =
    process.platform === "darwin"
      ? [{ command: "open", args: [url] }]
      : process.platform === "win32"
        ? [{ command: "cmd", args: ["/c", "start", "", url] }]
        : [{ command: "xdg-open", args: [url] }];

  for (const candidate of candidates) {
    try {
      const exitCode = await runInteractiveCommand(candidate.command, candidate.args);
      if (exitCode === 0) {
        return true;
      }
    } catch {
      // Try the next opener.
    }
  }

  return false;
}

async function runServiceCommands(
  runner: InteractiveRunner,
  commands: ServiceCommand[],
): Promise<void> {
  for (const entry of commands) {
    const exitCode = await runner(entry.command, entry.args);
    if (exitCode !== 0) {
      throw new Error(`Command failed with exit code ${exitCode}: ${entry.command} ${entry.args.join(" ")}`);
    }
  }
}

function parseTimeoutSeconds(value: string | boolean | undefined, command: string): number {
  const timeoutSeconds = typeof value === "string" ? Number(value) : 180;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`${command} --timeout must be a positive number of seconds.`);
  }
  return timeoutSeconds;
}

async function runConnectFlow(params: {
  config: AppConfig;
  data: CliDataAccess;
  stdout: Output;
  openExternal?: (url: string) => Promise<boolean>;
  connectPollIntervalMs?: number;
  noOpen?: boolean;
  timeoutSeconds?: number;
  projectId?: string;
  json?: boolean;
}): Promise<number> {
  const result = await params.data.connect(params.projectId);
  if (params.json) {
    writeOutput(params.stdout, formatJson(result));
    return 0;
  }

  if ("completed" in result && result.completed) {
    const label = result.installation.workspaceName ?? result.installation.actorName ?? `installation #${result.installation.id}`;
    writeOutput(
      params.stdout,
      `Linked project ${result.projectId} to existing Linear installation ${result.installation.id} (${label}). No new OAuth approval was needed.\n`,
    );
    return 0;
  }
  if ("completed" in result) {
    throw new Error("Unexpected completed connect result.");
  }

  const opener = params.openExternal ?? openExternalUrl;
  const opened = params.noOpen ? false : await opener(result.authorizeUrl);
  writeOutput(
    params.stdout,
    `${result.projectId ? `Project: ${result.projectId}\n` : ""}${opened ? "Opened browser for Linear OAuth.\n" : "Open this URL in a browser:\n"}${opened ? result.authorizeUrl : `${result.authorizeUrl}\n`}Waiting for OAuth approval...\n`,
  );

  const deadline = Date.now() + (params.timeoutSeconds ?? 180) * 1000;
  const pollIntervalMs = params.connectPollIntervalMs ?? 1000;
  do {
    const status = await params.data.connectStatus(result.state);
    if (status.status === "completed") {
      const label = status.installation?.workspaceName ?? status.installation?.actorName ?? `installation #${status.installation?.id ?? "unknown"}`;
      writeOutput(
        params.stdout,
        [
          `Connected ${label}${status.projectId ? ` for project ${status.projectId}` : ""}.${status.installation?.id ? ` Installation ${status.installation.id}.` : ""}`,
          params.config.linear.oauth.actor === "app"
            ? "If your Linear OAuth app webhook settings are configured, Linear has now provisioned the workspace webhook automatically."
            : undefined,
        ]
          .filter(Boolean)
          .join("\n") + "\n",
      );
      return 0;
    }
    if (status.status === "failed") {
      throw new Error(status.errorMessage ?? "Linear OAuth failed.");
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Linear OAuth after ${params.timeoutSeconds ?? 180} seconds.`);
    }
    await delay(pollIntervalMs);
  } while (true);
}

async function tryManageService(
  runner: InteractiveRunner,
  commands: ServiceCommand[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await runServiceCommands(runner, commands);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function installServiceCommands(): ServiceCommand[] {
  return [
    { command: "systemctl", args: ["--user", "daemon-reload"] },
    { command: "systemctl", args: ["--user", "enable", "--now", "patchrelay.path"] },
    { command: "systemctl", args: ["--user", "enable", "patchrelay.service"] },
    { command: "systemctl", args: ["--user", "reload-or-restart", "patchrelay.service"] },
  ];
}

function restartServiceCommands(): ServiceCommand[] {
  return [
    { command: "systemctl", args: ["--user", "daemon-reload"] },
    { command: "systemctl", args: ["--user", "reload-or-restart", "patchrelay.service"] },
  ];
}

export async function runCli(
  argv: string[],
  options?: {
    stdout?: Output;
    stderr?: Output;
    config?: AppConfig;
    data?: CliDataAccess;
    runInteractive?: InteractiveRunner;
    openExternal?: (url: string) => Promise<boolean>;
    connectPollIntervalMs?: number;
  },
): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const parsed = parseArgs(argv);
  const requestedCommand = parsed.positionals[0];
  const command = !requestedCommand
    ? "help"
    : KNOWN_COMMANDS.has(requestedCommand)
      ? requestedCommand
      : "inspect";
  const commandArgs = command === requestedCommand ? parsed.positionals.slice(1) : parsed.positionals;
  if (command === "help") {
    writeOutput(stdout, `${helpText()}\n`);
    return 0;
  }
  if (command === "serve") {
    return -1;
  }

  const runInteractive = options?.runInteractive ?? runInteractiveCommand;
  const json = parsed.flags.get("json") === true;

  if (command === "init") {
    try {
      const requestedPublicBaseUrl =
        typeof parsed.flags.get("public-base-url") === "string"
          ? String(parsed.flags.get("public-base-url"))
          : commandArgs[0];
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
        force: parsed.flags.get("force") === true,
        publicBaseUrl,
      });
      const serviceUnits = await installUserServiceUnits({ force: parsed.flags.get("force") === true });
      const serviceState = await tryManageService(runInteractive, installServiceCommands());
      writeOutput(
        stdout,
        json
          ? formatJson({ ...result, serviceUnits, serviceState })
          : [
              `Config directory: ${result.configDir}`,
              `Env file: ${result.envPath} (${result.envStatus})`,
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
              `- Database, logs, bind address, worktree roots, workflow file names, and workflow states use built-in defaults`,
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
              `1. Edit ${result.envPath}`,
              "2. Paste your Linear OAuth client id and client secret into that .env and keep the generated webhook secret and token encryption key",
              "3. Paste LINEAR_WEBHOOK_SECRET from that .env into the Linear OAuth app webhook signing secret",
              "4. Run `patchrelay project apply <id> <repo-path>`",
              "5. If workflow files were missing, add repo workflow files such as IMPLEMENTATION_WORKFLOW.md, REVIEW_WORKFLOW.md, and DEPLOY_WORKFLOW.md, then rerun `patchrelay project apply`",
              "6. Run `patchrelay doctor`",
            ]
              .filter(Boolean)
              .join("\n") + "\n",
      );
      return 0;
    } catch (error) {
      writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (command === "install-service") {
    try {
      const result = await installUserServiceUnits({ force: parsed.flags.get("force") === true });
      const writeOnly = parsed.flags.get("write-only") === true;
      if (!writeOnly) {
        await runServiceCommands(runInteractive, installServiceCommands());
      }
      writeOutput(
        stdout,
        json
          ? formatJson({ ...result, writeOnly })
          : [
              `Service unit: ${result.unitPath} (${result.serviceStatus})`,
              `Reload unit: ${result.reloadUnitPath} (${result.reloadStatus})`,
              `Watcher unit: ${result.pathUnitPath} (${result.pathStatus})`,
              `Env file: ${result.envPath}`,
              `Config file: ${result.configPath}`,
              writeOnly
                ? "Service units written. Start them with: systemctl --user daemon-reload && systemctl --user enable --now patchrelay.path && systemctl --user enable patchrelay.service && systemctl --user reload-or-restart patchrelay.service"
                : "PatchRelay user service and config watcher are installed and running.",
              "After package updates, run: patchrelay restart-service",
            ].join("\n") + "\n",
      );
      return 0;
    } catch (error) {
      writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (command === "restart-service") {
    try {
      await runServiceCommands(runInteractive, restartServiceCommands());
      writeOutput(
        stdout,
        json
          ? formatJson({
              service: "patchrelay",
              unitPath: getSystemdUserUnitPath(),
              reloadUnitPath: getSystemdUserReloadUnitPath(),
              pathUnitPath: getSystemdUserPathUnitPath(),
              envPath: getDefaultEnvPath(),
              configPath: getDefaultConfigPath(),
              restarted: true,
            })
          : "Reloaded systemd user units and reload-or-restart was requested for PatchRelay.\n",
      );
      return 0;
    } catch (error) {
      writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (command === "project") {
    try {
      const subcommand = commandArgs[0];
      if (subcommand !== "apply") {
        throw new Error(
          "Usage: patchrelay project apply <id> <repo-path> [--issue-prefix <prefixes>] [--team-id <ids>] [--no-connect] [--timeout <seconds>]",
        );
      }

      const projectId = commandArgs[1];
      const repoPath = commandArgs[2];
      if (!projectId || !repoPath) {
        throw new Error(
          "Usage: patchrelay project apply <id> <repo-path> [--issue-prefix <prefixes>] [--team-id <ids>] [--no-connect] [--timeout <seconds>]",
        );
      }

      const result = await upsertProjectInConfig({
        id: projectId,
        repoPath,
        issueKeyPrefixes: parseCsvFlag(parsed.flags.get("issue-prefix")),
        linearTeamIds: parseCsvFlag(parsed.flags.get("team-id")),
      });
      const serviceUnits = await installUserServiceUnits();
      const noConnect = parsed.flags.get("no-connect") === true;

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
        fullConfig = loadConfig(undefined, { requireLinearSecret: false });
      } catch (error) {
        if (json) {
          writeOutput(
            stdout,
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
        writeOutput(stdout, `${lines.join("\n")}\n`);
        return 0;
      }

      const report = await runPreflight(fullConfig);
      const failedChecks = report.checks.filter((check) => check.status === "fail");
      if (failedChecks.length > 0) {
        if (json) {
          writeOutput(
            stdout,
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
        writeOutput(stdout, `${lines.join("\n")}\n`);
        return 0;
      }

      const serviceState = await tryManageService(runInteractive, installServiceCommands());
      if (!serviceState.ok) {
        throw new Error(`Project was saved, but PatchRelay could not be reloaded: ${serviceState.error}`);
      }

      const cliData = options?.data ?? new CliDataAccess(fullConfig);
      try {
        if (json) {
          const connectResult = noConnect ? undefined : await cliData.connect(projectId);
          writeOutput(
            stdout,
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
        writeOutput(stdout, `${lines.join("\n")}\n`);
        return 0;
      }

      writeOutput(stdout, `${lines.join("\n")}\n`);
        return await runConnectFlow({
          config: fullConfig,
          data: cliData,
          stdout,
          noOpen: parsed.flags.get("no-open") === true,
          timeoutSeconds: parseTimeoutSeconds(parsed.flags.get("timeout"), "project apply"),
          projectId,
          ...(options?.openExternal ? { openExternal: options.openExternal } : {}),
          ...(options?.connectPollIntervalMs !== undefined ? { connectPollIntervalMs: options.connectPollIntervalMs } : {}),
        });
      } finally {
        if (!options?.data) {
          cliData.close();
        }
      }
    } catch (error) {
      writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const config =
    options?.config ??
    loadConfig(undefined, {
      requireLinearSecret: false,
      allowMissingSecrets: command === "doctor" || command === "install-service",
    });
  let data = options?.data;

  try {
    if (command === "doctor") {
      const report = await runPreflight(config);
      writeOutput(stdout, json ? formatJson(report) : formatDoctor(report));
      return report.ok ? 0 : 1;
    }

    data ??= new CliDataAccess(config);

    if (command === "inspect") {
      const issueKey = commandArgs[0];
      if (!issueKey) {
        throw new Error("inspect requires <issueKey>.");
      }
      const result = await data.inspect(issueKey);
      if (!result) {
        throw new Error(`Issue not found: ${issueKey}`);
      }
      writeOutput(stdout, json ? formatJson(result) : formatInspect(result));
      return 0;
    }

    if (command === "live") {
      const issueKey = commandArgs[0];
      if (!issueKey) {
        throw new Error("live requires <issueKey>.");
      }
      const watch = parsed.flags.get("watch") === true;
      do {
        const result = await data.live(issueKey);
        if (!result) {
          throw new Error(`No active stage found for ${issueKey}`);
        }
        writeOutput(stdout, json ? formatJson(result) : formatLive(result));
        if (!watch || result.stageRun.status !== "running") {
          break;
        }
        await delay(2000);
      } while (true);
      return 0;
    }

    if (command === "report") {
      const issueKey = commandArgs[0];
      if (!issueKey) {
        throw new Error("report requires <issueKey>.");
      }
      const reportOptions: { stage?: WorkflowStage; stageRunId?: number } = {};
      const stage = getStageFlag(parsed.flags.get("stage"));
      if (stage) {
        reportOptions.stage = stage;
      }
      if (typeof parsed.flags.get("stage-run") === "string") {
        reportOptions.stageRunId = Number(parsed.flags.get("stage-run"));
      }
      const result = data.report(issueKey, reportOptions);
      if (!result) {
        throw new Error(`Issue not found: ${issueKey}`);
      }
      writeOutput(stdout, json ? formatJson(result) : formatReport(result));
      return 0;
    }

    if (command === "events") {
      const issueKey = commandArgs[0];
      if (!issueKey) {
        throw new Error("events requires <issueKey>.");
      }
      const follow = parsed.flags.get("follow") === true;
      let afterId: number | undefined;
      let stageRunId =
        typeof parsed.flags.get("stage-run") === "string" ? Number(parsed.flags.get("stage-run")) : undefined;
      do {
        const result = data.events(issueKey, {
          ...(stageRunId !== undefined ? { stageRunId } : {}),
          ...(typeof parsed.flags.get("method") === "string" ? { method: String(parsed.flags.get("method")) } : {}),
          ...(afterId !== undefined ? { afterId } : {}),
        });
        if (!result) {
          throw new Error(`Stage run not found for ${issueKey}`);
        }
        stageRunId = result.stageRun.id;
        if (result.events.length > 0) {
          writeOutput(stdout, json ? formatJson(result) : formatEvents(result));
          afterId = result.events.at(-1)?.id;
        }
        if (!follow || result.stageRun.status !== "running") {
          break;
        }
        await delay(2000);
      } while (true);
      return 0;
    }

    if (command === "worktree") {
      const issueKey = commandArgs[0];
      if (!issueKey) {
        throw new Error("worktree requires <issueKey>.");
      }
      const result = data.worktree(issueKey);
      if (!result) {
        throw new Error(`Workspace not found for ${issueKey}`);
      }
      writeOutput(stdout, json ? formatJson(result) : formatWorktree(result, parsed.flags.get("cd") === true));
      return 0;
    }

    if (command === "open") {
      const issueKey = commandArgs[0];
      if (!issueKey) {
        throw new Error("open requires <issueKey>.");
      }
      const result = data.open(issueKey);
      if (!result) {
        throw new Error(`Workspace not found for ${issueKey}`);
      }
      if (json) {
        writeOutput(stdout, formatJson(result));
        return 0;
      }
      if (parsed.flags.get("print") === true) {
        writeOutput(stdout, formatOpen(result));
        return 0;
      }

      const openCommand = buildOpenCommand(config, result.workspace.worktreePath, result.resumeThreadId);
      return await runInteractive(openCommand.command, openCommand.args);
    }

    if (command === "connect") {
      return await runConnectFlow({
        config,
        data,
        stdout,
        noOpen: parsed.flags.get("no-open") === true,
        timeoutSeconds: parseTimeoutSeconds(parsed.flags.get("timeout"), "connect"),
        json,
        ...(options?.openExternal ? { openExternal: options.openExternal } : {}),
        ...(options?.connectPollIntervalMs !== undefined ? { connectPollIntervalMs: options.connectPollIntervalMs } : {}),
        ...(typeof parsed.flags.get("project") === "string" ? { projectId: String(parsed.flags.get("project")) } : {}),
      });
    }

    if (command === "installations") {
      const result = await data.listInstallations();
      if (json) {
        writeOutput(stdout, formatJson(result));
        return 0;
      }
      writeOutput(
        stdout,
        `${(result.installations.length > 0
          ? result.installations.map((item) => `${item.installation.id}  ${item.installation.workspaceName ?? item.installation.actorName ?? "-"}  projects=${item.linkedProjects.join(",") || "-"}`)
          : ["No installations found."]).join("\n")}\n`,
      );
      return 0;
    }

    if (command === "retry") {
      const issueKey = commandArgs[0];
      if (!issueKey) {
        throw new Error("retry requires <issueKey>.");
      }
      const retryOptions: { stage?: WorkflowStage; reason?: string } = {};
      const stage = getStageFlag(parsed.flags.get("stage"));
      if (stage) {
        retryOptions.stage = stage;
      }
      if (typeof parsed.flags.get("reason") === "string") {
        retryOptions.reason = String(parsed.flags.get("reason"));
      }
      const result = data.retry(issueKey, retryOptions);
      if (!result) {
        throw new Error(`Issue not found: ${issueKey}`);
      }
      writeOutput(stdout, json ? formatJson(result) : formatRetry(result));
      return 0;
    }

    if (command === "list") {
      const result = data.list({
        active: parsed.flags.get("active") === true,
        failed: parsed.flags.get("failed") === true,
        ...(typeof parsed.flags.get("project") === "string" ? { project: String(parsed.flags.get("project")) } : {}),
      });
      writeOutput(stdout, json ? formatJson(result) : formatList(result));
      return 0;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (data && !options?.data) {
      data.close();
    }
  }
}
