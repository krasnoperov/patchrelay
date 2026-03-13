import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig, WorkflowStage } from "../../types.ts";
import { getStageFlag } from "../args.ts";
import type { InteractiveRunner, Output, ParsedArgs } from "../command-types.ts";
import type { CliDataAccess } from "../data.ts";
import { formatJson } from "../formatters/json.ts";
import { formatEvents, formatInspect, formatList, formatLive, formatOpen, formatReport, formatRetry, formatWorktree } from "../formatters/text.ts";
import { buildOpenCommand } from "../interactive.ts";
import { writeOutput } from "../output.ts";

interface IssueCommandParams {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  data: CliDataAccess;
  config: AppConfig;
  runInteractive: InteractiveRunner;
}

export async function handleInspectCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("inspect requires <issueKey>.");
  }
  const result = await params.data.inspect(issueKey);
  if (!result) {
    throw new Error(`Issue not found: ${issueKey}`);
  }
  writeOutput(params.stdout, params.json ? formatJson(result) : formatInspect(result));
  return 0;
}

export async function handleLiveCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("live requires <issueKey>.");
  }
  const watch = params.parsed.flags.get("watch") === true;
  do {
    const result = await params.data.live(issueKey);
    if (!result) {
      throw new Error(`No active stage found for ${issueKey}`);
    }
    writeOutput(params.stdout, params.json ? formatJson(result) : formatLive(result));
    if (!watch || result.stageRun.status !== "running") {
      break;
    }
    await delay(2000);
  } while (true);
  return 0;
}

export async function handleReportCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("report requires <issueKey>.");
  }
  const reportOptions: { stage?: WorkflowStage; stageRunId?: number } = {};
  const stage = getStageFlag(params.parsed.flags.get("stage"));
  if (stage) {
    reportOptions.stage = stage;
  }
  if (typeof params.parsed.flags.get("stage-run") === "string") {
    reportOptions.stageRunId = Number(params.parsed.flags.get("stage-run"));
  }
  const result = params.data.report(issueKey, reportOptions);
  if (!result) {
    throw new Error(`Issue not found: ${issueKey}`);
  }
  writeOutput(params.stdout, params.json ? formatJson(result) : formatReport(result));
  return 0;
}

export async function handleEventsCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("events requires <issueKey>.");
  }
  const follow = params.parsed.flags.get("follow") === true;
  let afterId: number | undefined;
  let stageRunId =
    typeof params.parsed.flags.get("stage-run") === "string" ? Number(params.parsed.flags.get("stage-run")) : undefined;
  do {
    const result = params.data.events(issueKey, {
      ...(stageRunId !== undefined ? { stageRunId } : {}),
      ...(typeof params.parsed.flags.get("method") === "string" ? { method: String(params.parsed.flags.get("method")) } : {}),
      ...(afterId !== undefined ? { afterId } : {}),
    });
    if (!result) {
      throw new Error(`Stage run not found for ${issueKey}`);
    }
    stageRunId = result.stageRun.id;
    if (result.events.length > 0) {
      writeOutput(params.stdout, params.json ? formatJson(result) : formatEvents(result));
      afterId = result.events.at(-1)?.id;
    }
    if (!follow || result.stageRun.status !== "running") {
      break;
    }
    await delay(2000);
  } while (true);
  return 0;
}

export async function handleWorktreeCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("worktree requires <issueKey>.");
  }
  const result = params.data.worktree(issueKey);
  if (!result) {
    throw new Error(`Workspace not found for ${issueKey}`);
  }
  writeOutput(params.stdout, params.json ? formatJson(result) : formatWorktree(result, params.parsed.flags.get("cd") === true));
  return 0;
}

export async function handleOpenCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("open requires <issueKey>.");
  }
  const result = params.data.open(issueKey);
  if (!result) {
    throw new Error(`Workspace not found for ${issueKey}`);
  }
  if (params.json) {
    writeOutput(params.stdout, formatJson(result));
    return 0;
  }
  if (params.parsed.flags.get("print") === true) {
    writeOutput(params.stdout, formatOpen(result));
    return 0;
  }

  const openCommand = buildOpenCommand(params.config, result.workspace.worktreePath, result.resumeThreadId);
  return await params.runInteractive(openCommand.command, openCommand.args);
}

export async function handleRetryCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("retry requires <issueKey>.");
  }
  const retryOptions: { stage?: WorkflowStage; reason?: string } = {};
  const stage = getStageFlag(params.parsed.flags.get("stage"));
  if (stage) {
    retryOptions.stage = stage;
  }
  if (typeof params.parsed.flags.get("reason") === "string") {
    retryOptions.reason = String(params.parsed.flags.get("reason"));
  }
  const result = params.data.retry(issueKey, retryOptions);
  if (!result) {
    throw new Error(`Issue not found: ${issueKey}`);
  }
  writeOutput(params.stdout, params.json ? formatJson(result) : formatRetry(result));
  return 0;
}

export async function handleListCommand(params: IssueCommandParams): Promise<number> {
  const result = params.data.list({
    active: params.parsed.flags.get("active") === true,
    failed: params.parsed.flags.get("failed") === true,
    ...(typeof params.parsed.flags.get("project") === "string" ? { project: String(params.parsed.flags.get("project")) } : {}),
  });
  writeOutput(params.stdout, params.json ? formatJson(result) : formatList(result));
  return 0;
}
