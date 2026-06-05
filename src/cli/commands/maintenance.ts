import { runWebhookEventRetention } from "../../event-retention.ts";
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
  if (subcommand !== "prune-events") {
    throw new CliUsageError(`Unknown maintenance command: ${subcommand ?? ""}`.trim(), "maintenance");
  }

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
