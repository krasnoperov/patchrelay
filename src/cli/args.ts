import type { ParsedArgs, ResolvedCommand } from "./command-types.ts";
import { UnknownCommandError, UnknownFlagsError } from "./errors.ts";

export const KNOWN_COMMANDS = new Set([
  "version",
  "serve",
  "issue",
  "cluster",
  "doctor",
  "init",
  "attach",
  "repos",
  "linear",
  "repo",
  "dashboard",
  "dash",
  "d",
  "service",
  "connect",
  "installations",
  "help",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "-h" || value === "--help") {
      flags.set("help", true);
      continue;
    }
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
    if (requestedCommand === "attach") {
      return { command: "repo", commandArgs: ["link", ...parsed.positionals.slice(1)] };
    }
    if (requestedCommand === "repos") {
      const rest = parsed.positionals.slice(1);
      if (rest.length === 0) {
        return { command: "repo", commandArgs: ["list"] };
      }
      if (["list", "show", "link", "unlink", "sync"].includes(rest[0]!)) {
        return { command: "repo", commandArgs: rest };
      }
      return { command: "repo", commandArgs: ["show", ...rest] };
    }
    if (requestedCommand === "connect") {
      return { command: "linear", commandArgs: ["connect", ...parsed.positionals.slice(1)] };
    }
    if (requestedCommand === "installations") {
      return { command: "linear", commandArgs: ["list", ...parsed.positionals.slice(1)] };
    }

    const command =
      requestedCommand === "dash" || requestedCommand === "d"
        ? "dashboard"
        : requestedCommand;
    return { command, commandArgs: parsed.positionals.slice(1) };
  }

  throw new UnknownCommandError(requestedCommand);
}

export function hasHelpFlag(parsed: ParsedArgs): boolean {
  return parsed.flags.get("help") === true;
}

export function getRunTypeFlag(value: string | boolean | undefined): string | undefined {
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
  const allowed = new Set(["help", ...allowedFlags]);
  const unknownFlags = [...parsed.flags.keys()].filter((flag) => !allowed.has(flag)).sort();
  if (unknownFlags.length === 0) {
    return;
  }

  throw new UnknownFlagsError(
    unknownFlags,
    command === "repo"
      ? "repo"
      : command === "linear"
        ? "linear"
      : command === "issue"
        ? "issue"
        : command === "service"
          ? "service"
          : "root",
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
