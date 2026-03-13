import type { WorkflowStage } from "../types.ts";
import type { ParsedArgs } from "./command-types.ts";

export const KNOWN_COMMANDS = new Set([
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

export function parseArgs(argv: string[]): ParsedArgs {
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

export function resolveCommand(parsed: ParsedArgs): { command: string; commandArgs: string[] } {
  const requestedCommand = parsed.positionals[0];
  const command = !requestedCommand
    ? "help"
    : KNOWN_COMMANDS.has(requestedCommand)
      ? requestedCommand
      : "inspect";
  const commandArgs = command === requestedCommand ? parsed.positionals.slice(1) : parsed.positionals;
  return { command, commandArgs };
}

export function getStageFlag(value: string | boolean | undefined): WorkflowStage | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function parseCsvFlag(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
