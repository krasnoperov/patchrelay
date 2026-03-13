import { loadConfig, type ConfigLoadProfile } from "../config.ts";
import { runPreflight } from "../preflight.ts";
import { parseArgs, resolveCommand } from "./args.ts";
import { handleConnectCommand, handleInstallationsCommand } from "./commands/connect.ts";
import {
  handleEventsCommand,
  handleInspectCommand,
  handleListCommand,
  handleLiveCommand,
  handleOpenCommand,
  handleReportCommand,
  handleRetryCommand,
  handleWorktreeCommand,
} from "./commands/issues.ts";
import { handleProjectCommand } from "./commands/project.ts";
import { handleInitCommand, handleInstallServiceCommand, handleRestartServiceCommand } from "./commands/setup.ts";
import type { RunCliOptions } from "./command-types.ts";
import { CliDataAccess } from "./data.ts";
import { formatJson } from "./formatters/json.ts";
import { runInteractiveCommand } from "./interactive.ts";
import { formatDoctor, writeOutput } from "./output.ts";

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
    "  2. Fill in ~/.config/patchrelay/service.env",
    "  3. patchrelay project apply <id> <repo-path>",
    "  4. Edit the generated project workflows if needed, then add those workflow files to the repo",
    "  5. patchrelay doctor",
    "",
    "Why init needs the public URL:",
    "  Linear must reach PatchRelay at a public HTTPS origin for both the webhook endpoint",
    "  and the OAuth callback. `patchrelay init` writes that origin to `server.public_base_url`.",
    "",
    "Default behavior:",
    "  PatchRelay already defaults the local bind address, database path, log path, worktree",
    "  root, and Codex runner settings. In the normal",
    "  case you only need the public URL, the required secrets, and at least one project.",
    "  `patchrelay init` installs the user service and config watcher, and `project apply`",
    "  upserts the repo config and reuses or starts the Linear connection flow.",
    "",
    "Commands:",
    "  init <public-base-url> [--force] [--json]                Bootstrap the machine-level PatchRelay home",
    "  project apply <id> <repo-path> [--issue-prefix <prefixes>] [--team-id <ids>] [--no-connect] [--timeout <seconds>] [--json]",
    "                                                           Upsert one local repository and connect it to Linear when ready",
    "  doctor [--json]                                          Check secrets, paths, configured workflow files, git, and codex",
    "  install-service [--force] [--write-only] [--json]       Reinstall the systemd user service and watcher",
    "  restart-service [--json]                                Reload-or-restart the systemd user service",
    "  connect [--project <projectId>] [--no-open] [--timeout <seconds>] [--json]",
    "                                                           Advanced: start or reuse a Linear installation directly",
    "  installations [--json]                                  Show connected Linear installations",
    "  serve                                                   Run the local PatchRelay service",
    "  inspect <issueKey>                                      Show the latest known issue state",
    "  live <issueKey> [--watch] [--json]                      Show the active run status",
    "  report <issueKey> [--stage <workflow>] [--stage-run <id>] [--json]",
    "                                                           Show finished workflow reports",
    "  events <issueKey> [--stage-run <id>] [--method <name>] [--follow] [--json]",
    "                                                           Show raw thread events",
    "  worktree <issueKey> [--cd] [--json]                     Print the issue worktree path",
    "  open <issueKey> [--print] [--json]                      Open Codex in the issue worktree",
    "  retry <issueKey> [--stage <workflow>] [--reason <text>] [--json]",
    "                                                           Requeue a workflow",
    "  list [--active] [--failed] [--project <projectId>] [--json]",
    "                                                           List tracked issues",
  ].join("\n");
}

function getCommandConfigProfile(command: string): ConfigLoadProfile {
  switch (command) {
    case "doctor":
    case "install-service":
      return "doctor";
    case "connect":
    case "installations":
      return "operator_cli";
    case "inspect":
    case "live":
    case "report":
    case "events":
    case "worktree":
    case "open":
    case "retry":
    case "list":
      return "cli";
    default:
      return "service";
  }
}

export async function runCli(
  argv: string[],
  options?: RunCliOptions,
): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const parsed = parseArgs(argv);
  const { command, commandArgs } = resolveCommand(parsed);
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
    return await handleInitCommand({
      commandArgs,
      parsed,
      json,
      stdout,
      stderr,
      runInteractive,
    });
  }

  if (command === "install-service") {
    return await handleInstallServiceCommand({
      commandArgs,
      parsed,
      json,
      stdout,
      stderr,
      runInteractive,
    });
  }

  if (command === "restart-service") {
    return await handleRestartServiceCommand({
      commandArgs,
      parsed,
      json,
      stdout,
      stderr,
      runInteractive,
    });
  }

  if (command === "project") {
    return await handleProjectCommand({
      commandArgs,
      parsed,
      json,
      stdout,
      stderr,
      runInteractive,
      ...(options ? { options } : {}),
    });
  }

  const config =
    options?.config ??
    loadConfig(undefined, {
      profile: getCommandConfigProfile(command),
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
      return await handleInspectCommand({ commandArgs, parsed, json, stdout, data, config, runInteractive });
    }

    if (command === "live") {
      return await handleLiveCommand({ commandArgs, parsed, json, stdout, data, config, runInteractive });
    }

    if (command === "report") {
      return await handleReportCommand({ commandArgs, parsed, json, stdout, data, config, runInteractive });
    }

    if (command === "events") {
      return await handleEventsCommand({ commandArgs, parsed, json, stdout, data, config, runInteractive });
    }

    if (command === "worktree") {
      return await handleWorktreeCommand({ commandArgs, parsed, json, stdout, data, config, runInteractive });
    }

    if (command === "open") {
      return await handleOpenCommand({ commandArgs, parsed, json, stdout, data, config, runInteractive });
    }

    if (command === "connect") {
      return await handleConnectCommand({
        parsed,
        json,
        stdout,
        config,
        data,
        ...(options ? { options } : {}),
      });
    }

    if (command === "installations") {
      return await handleInstallationsCommand({
        json,
        stdout,
        data,
      });
    }

    if (command === "retry") {
      return await handleRetryCommand({ commandArgs, parsed, json, stdout, data, config, runInteractive });
    }

    if (command === "list") {
      return await handleListCommand({ commandArgs, parsed, json, stdout, data, config, runInteractive });
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
