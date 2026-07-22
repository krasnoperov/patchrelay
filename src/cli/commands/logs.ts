import { parsePositiveIntegerFlag } from "../args.ts";
import type { CommandRunner, InteractiveRunner, Output } from "../command-types.ts";
import { CliUsageError } from "../errors.ts";
import { formatJson } from "../formatters/json.ts";
import { writeOutput } from "../output.ts";

interface LogsCommandParams {
  issueKey?: string;
  follow: boolean;
  lines: string | boolean | undefined;
  json: boolean;
  stdout: Output;
  runCommand: CommandRunner;
  runInteractive: InteractiveRunner;
}

export async function handleLogsCommand(params: LogsCommandParams): Promise<number> {
  const lines = parsePositiveIntegerFlag(params.lines, "--lines") ?? 100;
  if (params.follow && params.json) {
    throw new CliUsageError("--json cannot be combined with --follow.");
  }

  const args = journalArgs(lines, params.issueKey);
  if (params.follow) {
    return await params.runInteractive("sudo", ["journalctl", ...args, "--follow"]);
  }

  const result = await params.runCommand("sudo", ["journalctl", ...args, "--no-pager"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to read PatchRelay logs.");
  }
  const logs = result.stdout.split(/\r?\n/).filter(Boolean);
  writeOutput(
    params.stdout,
    params.json
      ? formatJson({ service: "patchrelay", issueKey: params.issueKey, lines, logs })
      : `${result.stdout}${result.stdout.endsWith("\n") || result.stdout.length === 0 ? "" : "\n"}`,
  );
  return 0;
}

function journalArgs(lines: number, issueKey?: string): string[] {
  return [
    "-u",
    "patchrelay.service",
    "-n",
    String(lines),
    "-o",
    "short-iso",
    ...(issueKey ? ["--grep", issueKey] : []),
  ];
}
