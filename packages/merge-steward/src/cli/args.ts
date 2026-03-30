import type { ParsedArgs, HelpTopic } from "./types.ts";
import { UsageError } from "./types.ts";

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
    if (!name) continue;
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

export function hasHelpFlag(parsed: ParsedArgs): boolean {
  return parsed.flags.get("help") === true;
}

export function assertKnownFlags(parsed: ParsedArgs, helpTopic: HelpTopic, allowedFlags: string[]): void {
  const allowed = new Set(["help", ...allowedFlags]);
  const unknownFlags = [...parsed.flags.keys()].filter((flag) => !allowed.has(flag)).sort();
  if (unknownFlags.length === 0) {
    return;
  }
  throw new UsageError(`Unknown flag${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((flag) => `--${flag}`).join(", ")}`, helpTopic);
}

export function validateFlags(parsed: ParsedArgs): void {
  const command = parsed.positionals[0] ?? "help";
  const subcommand = parsed.positionals[1];

  switch (command) {
    case "help":
      assertKnownFlags(parsed, "root", []);
      return;
    case "init":
      assertKnownFlags(parsed, "root", ["force", "json"]);
      return;
    case "doctor":
      assertKnownFlags(parsed, "root", ["repo", "json"]);
      return;
    case "serve":
      assertKnownFlags(parsed, "root", ["config", "repo"]);
      return;
    case "attach":
      assertKnownFlags(parsed, "repos", ["base-branch", "required-check", "label", "json"]);
      return;
    case "repos":
      assertKnownFlags(parsed, "repos", ["json"]);
      return;
    case "service":
      switch (subcommand) {
        case "install":
          assertKnownFlags(parsed, "service", ["force", "json"]);
          return;
        case "restart":
          assertKnownFlags(parsed, "service", ["json"]);
          return;
        case "status":
          assertKnownFlags(parsed, "service", ["json"]);
          return;
        case "logs":
          assertKnownFlags(parsed, "service", ["lines", "json"]);
          return;
        default:
          assertKnownFlags(parsed, "service", []);
          return;
      }
    case "queue":
      switch (subcommand) {
        case "status":
          assertKnownFlags(parsed, "queue", ["repo", "events", "json"]);
          return;
        case "show":
          assertKnownFlags(parsed, "queue", ["repo", "entry", "pr", "events", "json"]);
          return;
        case "watch":
          assertKnownFlags(parsed, "queue", ["repo", "pr"]);
          return;
        case "reconcile":
          assertKnownFlags(parsed, "queue", ["repo", "json"]);
          return;
        default:
          assertKnownFlags(parsed, "queue", []);
          return;
      }
    default:
      assertKnownFlags(parsed, "root", []);
  }
}

export function parseCsvFlag(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function parseIntegerFlag(value: string | boolean | undefined, label: string): number | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^\d+$/.test(value.trim())) {
    throw new UsageError(`${label} must be a positive integer.`);
  }
  return Number(value.trim());
}
