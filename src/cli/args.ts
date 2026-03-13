import type { WorkflowStage } from "../types.ts";
import type { ParsedArgs, ResolvedCommand } from "./command-types.ts";

export const KNOWN_COMMANDS = new Set([
  "version",
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
  "feed",
  "install-service",
  "restart-service",
  "help",
]);

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

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

export function resolveCommand(parsed: ParsedArgs): ResolvedCommand {
  const requestedCommand = parsed.positionals[0];
  if (!requestedCommand) {
    return { command: "help", commandArgs: [] };
  }

  if (KNOWN_COMMANDS.has(requestedCommand)) {
    return { command: requestedCommand, commandArgs: parsed.positionals.slice(1) };
  }

  if (ISSUE_KEY_PATTERN.test(requestedCommand)) {
    return { command: "inspect", commandArgs: parsed.positionals };
  }

  throw new Error(`Unknown command: ${requestedCommand}. Run \`patchrelay help\`.`);
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

export function assertKnownFlags(parsed: ParsedArgs, command: string, allowedFlags: string[]): void {
  const allowed = new Set(allowedFlags);
  const unknownFlags = [...parsed.flags.keys()].filter((flag) => !allowed.has(flag)).sort();
  if (unknownFlags.length === 0) {
    return;
  }

  throw new Error(
    `Unknown flag${unknownFlags.length === 1 ? "" : "s"} for ${command}: ${unknownFlags.map((flag) => `--${flag}`).join(", ")}`,
  );
}

export function parsePositiveIntegerFlag(
  value: string | boolean | undefined,
  flagName: string,
): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${flagName} must be a positive integer.`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }

  return parsed;
}
