import type { AppConfig } from "../../types.ts";
import { getRunTypeFlag } from "../args.ts";
import type { InteractiveRunner, Output, ParsedArgs } from "../command-types.ts";
import type { CliDataAccess } from "../data.ts";
import { CliUsageError } from "../errors.ts";
import { formatJson } from "../formatters/json.ts";
import { formatClose, formatOpen, formatPrompt, formatRetry, formatWorktree } from "../formatters/text.ts";
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

export async function handleIssueCommand(params: IssueCommandParams): Promise<number> {
  const subcommand = params.commandArgs[0];
  if (!subcommand) {
    throw new CliUsageError("patchrelay issue requires a subcommand.", "issue");
  }

  const nested = {
    ...params,
    commandArgs: params.commandArgs.slice(1),
  };

  switch (subcommand) {
    case "path":
      return await handleWorktreeCommand(nested);
    case "open":
      return await handleOpenCommand(nested);
    case "prompt":
      return await handlePromptCommand(nested);
    case "retry":
      return await handleRetryCommand(nested);
    case "close":
      return await handleCloseCommand(nested);
    default:
      throw new CliUsageError(`Unknown issue command: ${subcommand}`, "issue");
  }
}

export async function handleWorktreeCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("path requires <issueKey>.");
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
  if (params.json) {
    const result = await params.data.resolveOpen(issueKey);
    if (!result) {
      throw new Error(`Workspace not found for ${issueKey}`);
    }
    writeOutput(params.stdout, formatJson(result));
    return 0;
  }
  if (params.parsed.flags.get("print") === true) {
    const result = await params.data.resolveOpen(issueKey);
    if (!result) {
      throw new Error(`Workspace not found for ${issueKey}`);
    }
    const openCommand = buildOpenCommand(params.config, result.worktreePath, result.resumeThreadId);
    writeOutput(params.stdout, formatOpen(result, openCommand));
    return 0;
  }

  const result = await params.data.prepareOpen(issueKey);
  if (!result) {
    throw new Error(`Workspace not found for ${issueKey}`);
  }
  const openCommand = buildOpenCommand(params.config, result.worktreePath, result.resumeThreadId);
  return await params.runInteractive(openCommand.command, openCommand.args);
}

export async function handleRetryCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("retry requires <issueKey>.");
  }
  const retryOptions: { runType?: string; reason?: string } = {};
  const runType = getRunTypeFlag(params.parsed.flags.get("run-type"));
  if (runType) {
    retryOptions.runType = runType;
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

export async function handlePromptCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("prompt requires <issueKey>.");
  }

  const text = params.commandArgs.slice(1).join(" ").trim();
  if (!text) {
    throw new Error("prompt requires <text>.");
  }

  const result = await params.data.promptIssue(issueKey, text);
  const payload = { issueKey, ...result };
  writeOutput(params.stdout, params.json ? formatJson(payload) : formatPrompt(payload));
  return 0;
}

export async function handleCloseCommand(params: IssueCommandParams): Promise<number> {
  const issueKey = params.commandArgs[0];
  if (!issueKey) {
    throw new Error("close requires <issueKey>.");
  }
  const result = params.data.closeIssue(issueKey, {
    failed: params.parsed.flags.get("failed") === true,
    ...(typeof params.parsed.flags.get("reason") === "string"
      ? { reason: String(params.parsed.flags.get("reason")) }
      : {}),
  });
  if (!result) {
    throw new Error(`Issue not found: ${issueKey}`);
  }
  writeOutput(params.stdout, params.json ? formatJson(result) : formatClose(result));
  return 0;
}
