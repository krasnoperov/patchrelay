import { runWebhookEventRetention } from "../../event-retention.ts";
import { runTerminalWorktreeCleanup } from "../../worktree-cleanup.ts";
import type { AppConfig } from "../../types.ts";
import type { ParsedArgs, Output } from "../command-types.ts";
import type { CliDataAccess } from "../data.ts";
import { CliUsageError } from "../errors.ts";
import { formatJson } from "../formatters/json.ts";
import { writeOutput } from "../output.ts";

export async function handleMaintenanceCommand(params: {
  commandArgs: string[];
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  data: CliDataAccess;
  config: AppConfig;
}): Promise<number> {
  const [subcommand] = params.commandArgs;
  if (subcommand === "prune-events") {
    return await handlePruneEventsCommand(params);
  }
  if (subcommand === "prune-worktrees") {
    return await handlePruneWorktreesCommand(params);
  }

  throw new CliUsageError(`Unknown maintenance command: ${subcommand ?? ""}`.trim(), "maintenance");
}

async function handlePruneEventsCommand(params: {
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  data: CliDataAccess;
  config: AppConfig;
}): Promise<number> {
  const retentionDays = readPositiveIntegerFlag(params.parsed, "retention-days");
  const batchSize = readPositiveIntegerFlag(params.parsed, "batch-size");
  const archive = params.parsed.flags.get("archive") === true;
  const discard = params.parsed.flags.get("discard") === true;
  if (archive && discard) {
    throw new CliUsageError("Use either --archive or --discard, not both", "maintenance");
  }

  const result = await runWebhookEventRetention({
    db: params.data.db,
    config: params.config,
    options: {
      dryRun: params.parsed.flags.get("dry-run") === true,
      ...(retentionDays !== undefined ? { retentionDays } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
      ...(archive ? { archiveOldEvents: true } : {}),
      ...(discard ? { archiveOldEvents: false } : {}),
    },
  });

  if (params.json) {
    writeOutput(params.stdout, formatJson(result));
    return 0;
  }

  writeOutput(
    params.stdout,
    [
      `Cutoff: ${result.cutoffIso}`,
      `Scanned: ${result.scanned}`,
      `Archived: ${result.archived}`,
      `Deleted: ${result.deleted}`,
      `Remaining: ${result.remaining}`,
      result.archiveFile ? `Archive: ${result.archiveFile}` : undefined,
      result.dryRun ? "Dry run: yes" : undefined,
    ].filter(Boolean).join("\n") + "\n",
  );
  return 0;
}

async function handlePruneWorktreesCommand(params: {
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  data: CliDataAccess;
  config: AppConfig;
}): Promise<number> {
  const retentionHoursFlag = readNonNegativeIntegerFlag(params.parsed, "retention-hours");
  const retentionDaysFlag = readNonNegativeIntegerFlag(params.parsed, "retention-days");
  if (retentionHoursFlag !== undefined && retentionDaysFlag !== undefined) {
    throw new CliUsageError("Use either --retention-hours or --retention-days, not both", "maintenance");
  }
  const retentionHours = retentionHoursFlag ?? (retentionDaysFlag !== undefined ? retentionDaysFlag * 24 : undefined);
  const result = await runTerminalWorktreeCleanup({
    db: params.data.db,
    config: params.config,
    options: {
      dryRun: params.parsed.flags.get("dry-run") === true,
      ...(retentionHours !== undefined ? { retentionHours } : {}),
    },
  });

  if (params.json) {
    writeOutput(params.stdout, formatJson(result));
    return 0;
  }

  const actionLabel = result.dryRun ? "Would delete" : "Deleted";
  writeOutput(
    params.stdout,
    [
      `Cutoff: ${result.cutoffIso}`,
      `Scanned: ${result.scanned}`,
      `Eligible: ${result.eligible}`,
      `${actionLabel}: ${result.deleted}`,
      `Missing: ${result.missing}`,
      `Skipped active: ${result.skippedActive}`,
      `Skipped recent: ${result.skippedRecent}`,
      `Skipped state: ${result.skippedState}`,
      `Skipped outside root: ${result.skippedOutsideRoot}`,
      `Skipped dirty: ${result.skippedDirty}`,
      `Failed: ${result.failed}`,
      result.dryRun ? "Dry run: yes" : undefined,
      ...formatWorktreeSamples(result.skippedDirtyWorktrees, "Dirty"),
      ...formatWorktreeSamples(result.failures, "Failure"),
    ].filter(Boolean).join("\n") + "\n",
  );
  return 0;
}

function readPositiveIntegerFlag(parsed: ParsedArgs, flag: string): number | undefined {
  const value = parsed.flags.get(flag);
  if (value === undefined || value === false) return undefined;
  if (value === true) {
    throw new CliUsageError(`--${flag} requires a value`, "maintenance");
  }
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new CliUsageError(`--${flag} must be a positive integer`, "maintenance");
  }
  return parsedValue;
}

function readNonNegativeIntegerFlag(parsed: ParsedArgs, flag: string): number | undefined {
  const value = parsed.flags.get(flag);
  if (value === undefined || value === false) return undefined;
  if (value === true) {
    throw new CliUsageError(`--${flag} requires a value`, "maintenance");
  }
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new CliUsageError(`--${flag} must be a non-negative integer`, "maintenance");
  }
  return parsedValue;
}

function formatWorktreeSamples(
  items: Array<{ issueKey?: string | undefined; worktreePath: string; summary?: string | undefined; error?: string | undefined }>,
  label: string,
): string[] {
  return items.slice(0, 5).map((item) => {
    const prefix = item.issueKey ? `${label}: ${item.issueKey} ${item.worktreePath}` : `${label}: ${item.worktreePath}`;
    const detail = item.error ?? item.summary;
    return detail ? `${prefix} (${detail})` : prefix;
  });
}
