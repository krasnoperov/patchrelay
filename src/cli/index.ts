import { loadConfig, type ConfigLoadProfile } from "../config.ts";
import type { AppConfig } from "../types.ts";
import { getBuildInfo } from "../build-info.ts";
import { assertKnownFlags, hasHelpFlag, parseArgs, resolveCommand } from "./args.ts";
import { handleConnectCommand, handleInstallationsCommand } from "./commands/connect.ts";
import { handleFeedCommand } from "./commands/feed.ts";
import {
  handleIssueCommand,
} from "./commands/issues.ts";
import { handleAttachCommand, handleReposCommand } from "./commands/repos.ts";
import { handleInitCommand, handleServiceCommand } from "./commands/setup.ts";
import type { RunCliOptions } from "./command-types.ts";
import type { CliDataAccess } from "./data.ts";
import { CliUsageError } from "./errors.ts";
import { formatJson } from "./formatters/json.ts";
import { helpTextFor, rootHelpText } from "./help.ts";
import { runBufferedCommand, runInteractiveCommand } from "./interactive.ts";
import type { CliOperatorDataAccess } from "./operator-client.ts";
import { formatDoctor, writeOutput, writeUsageError } from "./output.ts";

function getCommandConfigProfile(command: string): ConfigLoadProfile {
  switch (command) {
    case "version":
      return "service";
    case "doctor":
    case "service":
      return "doctor";
    case "connect":
    case "installations":
    case "feed":
    case "dashboard":
      return "operator_cli";
    case "issue":
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
    case "issue": {
      switch (commandArgs[0]) {
        case "show":
          assertKnownFlags(parsed, "issue", ["json"]);
          return;
        case "list":
          assertKnownFlags(parsed, "issue", ["active", "failed", "repo", "json"]);
          return;
        case "watch":
          assertKnownFlags(parsed, "issue", ["json"]);
          return;
        case "report":
          assertKnownFlags(parsed, "issue", ["run-type", "run", "json"]);
          return;
        case "events":
          assertKnownFlags(parsed, "issue", ["run", "method", "follow", "json"]);
          return;
        case "path":
          assertKnownFlags(parsed, "issue", ["cd", "json"]);
          return;
        case "open":
          assertKnownFlags(parsed, "issue", ["print", "json"]);
          return;
        case "retry":
          assertKnownFlags(parsed, "issue", ["run-type", "reason", "json"]);
          return;
        default:
          assertKnownFlags(parsed, "issue", []);
          return;
      }
    }
    case "doctor":
      assertKnownFlags(parsed, command, ["json"]);
      return;
    case "init":
      assertKnownFlags(parsed, command, ["force", "json", "public-base-url"]);
      return;
    case "attach":
      assertKnownFlags(parsed, "attach", ["path", "prefix", "team", "no-auth", "no-open", "timeout", "json"]);
      return;
    case "repos":
      assertKnownFlags(parsed, "repos", ["json"]);
      return;
    case "service":
      if (commandArgs[0] === "install") {
        assertKnownFlags(parsed, "service", ["force", "write-only", "json"]);
        return;
      }
      if (commandArgs[0] === "restart") {
        assertKnownFlags(parsed, "service", ["json"]);
        return;
      }
      if (commandArgs[0] === "status") {
        assertKnownFlags(parsed, "service", ["json"]);
        return;
      }
      if (commandArgs[0] === "logs") {
        assertKnownFlags(parsed, "service", ["lines", "json"]);
        return;
      }
      assertKnownFlags(parsed, "service", []);
      return;
    case "connect":
      assertKnownFlags(parsed, command, ["repo", "no-open", "timeout", "json"]);
      return;
    case "installations":
      assertKnownFlags(parsed, command, ["json"]);
      return;
    case "feed":
      assertKnownFlags(parsed, command, ["follow", "limit", "issue", "repo", "kind", "stage", "status", "workflow", "json"]);
      return;
    case "dashboard":
      assertKnownFlags(parsed, command, ["issue"]);
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
    if (parsed.flags.get("version") === true) {
      const buildInfo = getBuildInfo();
      writeOutput(stdout, `${buildInfo.version}\n`);
      return 0;
    }
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
    if (topic === "attach" || topic === "repos" || topic === "issue" || topic === "service") {
      writeOutput(stdout, `${helpTextFor(topic === "attach" ? "repos" : topic)}\n`);
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
    const helpTopic =
      command === "attach" || command === "repos"
        ? "repos"
        : command === "issue" || command === "service"
          ? command
          : "root";
    writeOutput(
      stdout,
      `${helpTextFor(helpTopic)}\n`,
    );
    return 0;
  }
  if (command === "serve") {
    return -1;
  }

  const runInteractive = options?.runInteractive ?? runInteractiveCommand;
  const runCommand =
    options?.runCommand
    ?? (
      options?.runInteractive
        ? async (command: string, args: string[]) => ({
            exitCode: await options.runInteractive!(command, args),
            stdout: "",
            stderr: "",
          })
        : runBufferedCommand
    );

  if (command === "init") {
    return await handleInitCommand({
      commandArgs,
      parsed,
      json,
      stdout,
      stderr,
      runInteractive,
      runCommand,
    });
  }

  if (command === "service") {
    try {
      return await handleServiceCommand({
        commandArgs,
        parsed,
        json,
        stdout,
        stderr,
        runInteractive,
        runCommand,
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

  if (command === "attach") {
    try {
      return await handleAttachCommand({
        commandArgs,
        parsed,
        json,
        stdout,
        runInteractive,
        runCommand,
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

  if (command === "repos") {
    try {
      return await handleReposCommand({
        commandArgs,
        parsed,
        json,
        stdout,
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
      const cliVersion = getBuildInfo().version;
      let serviceVersion: string | undefined;
      try {
        const healthUrl = `http://${config.server.bind}:${config.server.port}${config.server.healthPath}`;
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        const body = await res.json() as { version?: string };
        serviceVersion = body.version ?? undefined;
      } catch { /* service not reachable */ }
      const doctorReport = { ...report, cliVersion, serviceVersion };
      writeOutput(stdout, json ? formatJson(doctorReport) : formatDoctor(doctorReport, cliVersion, serviceVersion));
      return report.ok ? 0 : 1;
    }

    if (command === "issue") {
      const issueData = await ensureIssueDataAccess(data, config);
      if (!data) {
        data = issueData;
        ownsData = true;
      }
      return await handleIssueCommand({
        commandArgs,
        parsed,
        json,
        stdout,
        data: issueData,
        config,
        runInteractive,
      });
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
        config,
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

    if (command === "dashboard") {
      const { handleWatchCommand } = await import("./commands/watch.ts");
      return await handleWatchCommand({ config, parsed });
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
