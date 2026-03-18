import { loadConfig, type ConfigLoadProfile } from "../config.ts";
import type { AppConfig } from "../types.ts";
import { getBuildInfo } from "../build-info.ts";
import { assertKnownFlags, hasHelpFlag, parseArgs, resolveCommand } from "./args.ts";
import { handleConnectCommand, handleInstallationsCommand } from "./commands/connect.ts";
import { handleFeedCommand } from "./commands/feed.ts";
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
import type { CliDataAccess } from "./data.ts";
import { CliUsageError } from "./errors.ts";
import { formatJson } from "./formatters/json.ts";
import { helpTextFor, rootHelpText } from "./help.ts";
import { runInteractiveCommand } from "./interactive.ts";
import type { CliOperatorDataAccess } from "./operator-client.ts";
import { formatDoctor, writeOutput, writeUsageError } from "./output.ts";

function getCommandConfigProfile(command: string): ConfigLoadProfile {
  switch (command) {
    case "version":
      return "service";
    case "doctor":
    case "install-service":
      return "doctor";
    case "connect":
    case "installations":
    case "feed":
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

function validateFlags(command: string, commandArgs: string[], parsed: ReturnType<typeof parseArgs>): void {
  switch (command) {
    case "version":
      assertKnownFlags(parsed, command, ["json"]);
      return;
    case "help":
    case "serve":
      assertKnownFlags(parsed, command, []);
      return;
    case "inspect":
      assertKnownFlags(parsed, command, ["json"]);
      return;
    case "live":
      assertKnownFlags(parsed, command, ["watch", "json"]);
      return;
    case "report":
      assertKnownFlags(parsed, command, ["stage", "stage-run", "json"]);
      return;
    case "events":
      assertKnownFlags(parsed, command, ["stage-run", "method", "follow", "json"]);
      return;
    case "worktree":
      assertKnownFlags(parsed, command, ["cd", "json"]);
      return;
    case "open":
      assertKnownFlags(parsed, command, ["print", "json"]);
      return;
    case "retry":
      assertKnownFlags(parsed, command, ["stage", "reason", "json"]);
      return;
    case "list":
      assertKnownFlags(parsed, command, ["active", "failed", "project", "json"]);
      return;
    case "doctor":
      assertKnownFlags(parsed, command, ["json"]);
      return;
    case "init":
      assertKnownFlags(parsed, command, ["force", "json", "public-base-url"]);
      return;
    case "project":
      if (commandArgs[0] === "apply") {
        assertKnownFlags(parsed, "project apply", ["issue-prefix", "team-id", "no-connect", "no-open", "timeout", "json"]);
        return;
      }
      assertKnownFlags(parsed, command, []);
      return;
    case "connect":
      assertKnownFlags(parsed, command, ["project", "no-open", "timeout", "json"]);
      return;
    case "installations":
      assertKnownFlags(parsed, command, ["json"]);
      return;
    case "feed":
      assertKnownFlags(parsed, command, ["follow", "limit", "issue", "project", "kind", "stage", "status", "workflow", "json"]);
      return;
    case "install-service":
      assertKnownFlags(parsed, command, ["force", "write-only", "json"]);
      return;
    case "restart-service":
      assertKnownFlags(parsed, command, ["json"]);
      return;
    default:
      return;
  }
}

export async function runCli(
  argv: string[],
  options?: RunCliOptions,
): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  let parsed: ReturnType<typeof parseArgs>;
  let command: string;
  let commandArgs: string[];
  try {
    parsed = parseArgs(argv);
    ({ command, commandArgs } = resolveCommand(parsed));
    validateFlags(command, commandArgs, parsed);
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeUsageError(stderr, error);
      return 1;
    }
    writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const json = parsed.flags.get("json") === true;
  if (command === "help") {
    const topic = commandArgs[0];
    if (topic === "project") {
      writeOutput(stdout, `${helpTextFor("project")}\n`);
      return 0;
    }
    if (topic) {
      writeUsageError(stderr, new CliUsageError(`Unknown help topic: ${topic}`));
      return 1;
    }
    writeOutput(stdout, `${rootHelpText()}\n`);
    return 0;
  }
  if (command === "version") {
    const buildInfo = getBuildInfo();
    writeOutput(stdout, json ? formatJson(buildInfo) : `${buildInfo.version}\n`);
    return 0;
  }
  if (hasHelpFlag(parsed)) {
    writeOutput(stdout, `${helpTextFor(command === "project" ? "project" : "root")}\n`);
    return 0;
  }
  if (command === "serve") {
    return -1;
  }

  const runInteractive = options?.runInteractive ?? runInteractiveCommand;

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
    try {
      return await handleProjectCommand({
        commandArgs,
        parsed,
        json,
        stdout,
        stderr,
        runInteractive,
        ...(options ? { options } : {}),
      });
    } catch (error) {
      if (error instanceof CliUsageError) {
        writeUsageError(stderr, error);
        return 1;
      }
      writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const config =
    options?.config ??
    loadConfig(undefined, {
      profile: getCommandConfigProfile(command),
    });
  let data = options?.data;
  let ownsData = false;

  try {
    if (command === "doctor") {
      const { runPreflight } = await import("../preflight.ts");
      const report = await runPreflight(config);
      writeOutput(stdout, json ? formatJson(report) : formatDoctor(report));
      return report.ok ? 0 : 1;
    }

    if (command === "inspect") {
      const issueData = await ensureIssueDataAccess(data, config);
      if (!data) {
        data = issueData;
        ownsData = true;
      }
      return await handleInspectCommand({ commandArgs, parsed, json, stdout, data: issueData, config, runInteractive });
    }

    if (command === "live") {
      const issueData = await ensureIssueDataAccess(data, config);
      if (!data) {
        data = issueData;
        ownsData = true;
      }
      return await handleLiveCommand({ commandArgs, parsed, json, stdout, data: issueData, config, runInteractive });
    }

    if (command === "report") {
      const issueData = await ensureIssueDataAccess(data, config);
      if (!data) {
        data = issueData;
        ownsData = true;
      }
      return await handleReportCommand({ commandArgs, parsed, json, stdout, data: issueData, config, runInteractive });
    }

    if (command === "events") {
      const issueData = await ensureIssueDataAccess(data, config);
      if (!data) {
        data = issueData;
        ownsData = true;
      }
      return await handleEventsCommand({ commandArgs, parsed, json, stdout, data: issueData, config, runInteractive });
    }

    if (command === "worktree") {
      const issueData = await ensureIssueDataAccess(data, config);
      if (!data) {
        data = issueData;
        ownsData = true;
      }
      return await handleWorktreeCommand({ commandArgs, parsed, json, stdout, data: issueData, config, runInteractive });
    }

    if (command === "open") {
      const issueData = await ensureIssueDataAccess(data, config);
      if (!data) {
        data = issueData;
        ownsData = true;
      }
      return await handleOpenCommand({ commandArgs, parsed, json, stdout, data: issueData, config, runInteractive });
    }

    if (command === "connect") {
      const operatorData = await ensureConnectDataAccess(data, config);
      if (!data) {
        data = operatorData;
        ownsData = true;
      }
      return await handleConnectCommand({
        parsed,
        json,
        stdout,
        config,
        data: operatorData,
        ...(options ? { options } : {}),
      });
    }

    if (command === "installations") {
      const operatorData = await ensureInstallationsDataAccess(data, config);
      if (!data) {
        data = operatorData;
        ownsData = true;
      }
      return await handleInstallationsCommand({
        json,
        stdout,
        data: operatorData,
      });
    }

    if (command === "feed") {
      const operatorData = parsed.flags.get("follow") === true
        ? await ensureFeedFollowDataAccess(data, config)
        : await ensureFeedListDataAccess(data, config);
      if (!data) {
        data = operatorData;
        ownsData = true;
      }
      return await handleFeedCommand({
        parsed,
        json,
        stdout,
        data: operatorData,
      });
    }

    if (command === "retry") {
      const issueData = await ensureIssueDataAccess(data, config);
      if (!data) {
        data = issueData;
        ownsData = true;
      }
      return await handleRetryCommand({ commandArgs, parsed, json, stdout, data: issueData, config, runInteractive });
    }

    if (command === "list") {
      const issueData = await ensureIssueDataAccess(data, config);
      if (!data) {
        data = issueData;
        ownsData = true;
      }
      return await handleListCommand({ commandArgs, parsed, json, stdout, data: issueData, config, runInteractive });
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeUsageError(stderr, error);
      return 1;
    }
    writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (ownsData && data) {
      data.close();
    }
  }
}

async function createCliDataAccess(config: AppConfig): Promise<CliDataAccess> {
  const { CliDataAccess } = await import("./data.ts");
  return new CliDataAccess(config);
}

async function createCliOperatorDataAccess(config: AppConfig): Promise<CliOperatorDataAccess> {
  const { CliOperatorApiClient } = await import("./operator-client.ts");
  return new CliOperatorApiClient(config);
}

async function ensureIssueDataAccess(
  data: RunCliOptions["data"],
  config: AppConfig,
): Promise<CliDataAccess> {
  if (data) {
    if (isIssueDataAccess(data)) {
      return data;
    }
    throw new Error("Issue inspection commands require local SQLite-backed CLI data access.");
  }

  return await createCliDataAccess(config);
}

async function ensureConnectDataAccess(
  data: RunCliOptions["data"],
  config: AppConfig,
): Promise<CliOperatorDataAccess> {
  if (data) {
    if (hasConnectDataAccess(data)) {
      return data;
    }
    throw new Error("The connect command requires HTTP-backed OAuth CLI data access.");
  }

  return await createCliOperatorDataAccess(config);
}

function isIssueDataAccess(data: RunCliOptions["data"]): data is CliDataAccess {
  return !!data && typeof data === "object" && "inspect" in data && typeof data.inspect === "function";
}

async function ensureInstallationsDataAccess(
  data: RunCliOptions["data"],
  config: AppConfig,
): Promise<CliOperatorDataAccess> {
  if (data) {
    if (hasInstallationsDataAccess(data)) {
      return data as CliOperatorDataAccess;
    }
    throw new Error("The installations command requires HTTP-backed installation data access.");
  }

  return await createCliOperatorDataAccess(config);
}

async function ensureFeedListDataAccess(
  data: RunCliOptions["data"],
  config: AppConfig,
): Promise<CliOperatorDataAccess> {
  if (data) {
    if (hasFeedListDataAccess(data)) {
      return data as CliOperatorDataAccess;
    }
    throw new Error("The feed command requires listOperatorFeed() data access.");
  }

  return await createCliOperatorDataAccess(config);
}

function hasConnectDataAccess(data: RunCliOptions["data"]): data is CliOperatorDataAccess {
  return !!data && typeof data === "object" && "connect" in data && typeof data.connect === "function";
}

function hasInstallationsDataAccess(data: RunCliOptions["data"]): boolean {
  return !!data && typeof data === "object" && "listInstallations" in data && typeof data.listInstallations === "function";
}

async function ensureFeedFollowDataAccess(
  data: RunCliOptions["data"],
  config: AppConfig,
): Promise<CliOperatorDataAccess> {
  if (data) {
    if (hasFeedFollowDataAccess(data)) {
      return data as CliOperatorDataAccess;
    }
    throw new Error("The feed --follow command requires followOperatorFeed() data access.");
  }

  return await createCliOperatorDataAccess(config);
}

function hasFeedListDataAccess(data: RunCliOptions["data"]): boolean {
  return !!data && typeof data === "object" && "listOperatorFeed" in data && typeof data.listOperatorFeed === "function";
}

function hasFeedFollowDataAccess(data: RunCliOptions["data"]): boolean {
  return !!data && typeof data === "object" && "followOperatorFeed" in data && typeof data.followOperatorFeed === "function";
}
