import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../config.js";
import { runPreflight } from "../preflight.js";
import { CliDataAccess } from "./data.js";
import { formatJson } from "./formatters/json.js";
import { formatEvents, formatInspect, formatList, formatLive, formatOpen, formatReport, formatRetry, formatWorktree } from "./formatters/text.js";
import type { AppConfig, WorkflowStage } from "../types.js";

type Output = Pick<NodeJS.WriteStream, "write">;

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
  "connect",
  "installations",
  "link-installation",
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
    "patchrelay <command> [args] [flags]",
    "",
    "Commands:",
    "  inspect <issueKey>",
    "  live <issueKey> [--watch] [--json]",
    "  report <issueKey> [--stage <stage>] [--stage-run <id>] [--json]",
    "  events <issueKey> [--stage-run <id>] [--method <name>] [--follow] [--json]",
    "  worktree <issueKey> [--cd] [--json]",
    "  open <issueKey> [--print] [--json]",
    "  retry <issueKey> [--stage <stage>] [--reason <text>] [--json]",
    "  list [--active] [--failed] [--project <projectId>] [--json]",
    "  doctor [--json]",
    "  connect [--project <projectId>] [--json]",
    "  installations [--json]",
    "  link-installation <projectId> <installationId|none> [--json]",
    "  serve",
  ].join("\n");
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

export async function runCli(
  argv: string[],
  options?: {
    stdout?: Output;
    stderr?: Output;
    config?: AppConfig;
    data?: CliDataAccess;
    runInteractive?: InteractiveRunner;
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

  const config = options?.config ?? loadConfig(undefined, { requireLinearSecret: false });
  let data = options?.data;
  const json = parsed.flags.get("json") === true;

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
      return await (options?.runInteractive ?? runInteractiveCommand)(openCommand.command, openCommand.args);
    }

    if (command === "connect") {
      const result = data.connect(typeof parsed.flags.get("project") === "string" ? String(parsed.flags.get("project")) : undefined);
      writeOutput(
        stdout,
        json ? formatJson(result) : `${result.projectId ? `Project: ${result.projectId}\n` : ""}Open this URL in a browser:\n${result.url}\n`,
      );
      return 0;
    }

    if (command === "installations") {
      const result = data.listInstallations();
      if (json) {
        writeOutput(stdout, formatJson(result));
        return 0;
      }
      writeOutput(
        stdout,
        `${(result.installations.length > 0
          ? result.installations.map((item) => `${item.id}  ${item.workspaceName ?? item.actorName ?? "-"}  projects=${item.linkedProjects.join(",") || "-"}`)
          : ["No installations found."]).join("\n")}\n`,
      );
      return 0;
    }

    if (command === "link-installation") {
      const projectId = commandArgs[0];
      const rawInstallationId = commandArgs[1];
      if (!projectId || !rawInstallationId) {
        throw new Error("link-installation requires <projectId> <installationId|none>.");
      }
      const installationId = rawInstallationId === "none" ? undefined : Number(rawInstallationId);
      if (rawInstallationId !== "none" && !Number.isFinite(installationId)) {
        throw new Error("link-installation requires <projectId> <installationId|none>.");
      }
      const result = data.linkInstallation(projectId, installationId);
      writeOutput(
        stdout,
        json
          ? formatJson(result)
          : installationId === undefined
            ? `Removed installation link for ${projectId}.\n`
            : `Linked ${projectId} to installation ${result.installationId}.\n`,
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
