export type HelpTopic = "root" | "repo" | "service";

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export class UsageError extends Error {
  constructor(message: string, readonly helpTopic: HelpTopic = "root") {
    super(message);
    this.name = "UsageError";
  }
}

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
    const [name, inline] = value.slice(2).split("=", 2);
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

function assertKnownFlags(parsed: ParsedArgs, helpTopic: HelpTopic, allowedFlags: string[]): void {
  const allowed = new Set(["help", ...allowedFlags]);
  const unknownFlags = [...parsed.flags.keys()].filter((flag) => !allowed.has(flag)).sort();
  if (unknownFlags.length === 0) return;
  throw new UsageError(`Unknown flag${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((flag) => `--${flag}`).join(", ")}`, helpTopic);
}

export function validateFlags(parsed: ParsedArgs): void {
  const command = parsed.positionals[0] ?? "help";
  const subcommand = parsed.positionals[1];

  switch (command) {
    case "help":
      assertKnownFlags(parsed, "root", []);
      return;
    case "version":
    case "serve":
      assertKnownFlags(parsed, "root", ["config"]);
      return;
    case "watch":
    case "dashboard":
      assertKnownFlags(parsed, "root", ["config"]);
      return;
    case "init":
      assertKnownFlags(parsed, "root", ["force", "json"]);
      return;
    case "attach":
      assertKnownFlags(parsed, "repo", ["base-branch", "required-check", "review-doc", "refresh", "json"]);
      return;
    case "repos":
      assertKnownFlags(parsed, "repo", ["json"]);
      return;
    case "repo":
      switch (subcommand) {
        case undefined:
        case "list":
        case "show":
          assertKnownFlags(parsed, "repo", ["json"]);
          return;
        case "attach":
          assertKnownFlags(parsed, "repo", ["base-branch", "required-check", "review-doc", "refresh", "json"]);
          return;
        default:
          assertKnownFlags(parsed, "repo", []);
          return;
      }
    case "doctor":
      assertKnownFlags(parsed, "root", ["repo", "json"]);
      return;
    case "attempts":
      assertKnownFlags(parsed, "root", ["json"]);
      return;
    case "transcript":
      assertKnownFlags(parsed, "root", ["attempt", "json"]);
      return;
    case "diff":
      assertKnownFlags(parsed, "root", [
        "repo",
        "base",
        "cwd",
        "ignore",
        "summarize-only",
        "budget",
        "json",
      ]);
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
    default:
      assertKnownFlags(parsed, "root", []);
  }
}

export function parseConfigPath(args: string[]): string | undefined {
  const index = args.findIndex((value) => value === "--config");
  if (index === -1) return undefined;
  return args[index + 1];
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

export function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new UsageError(`Public base URL must include http:// or https://. Received: ${value}`);
  }
  return trimmed;
}

export function parsePullRequestNumber(value: string | undefined): number {
  if (!value?.trim()) {
    throw new UsageError("review-quill attempts requires <repo> <pr-number>.");
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new UsageError(`PR number must be a positive integer. Received: ${value}`);
  }
  return Number(value.trim());
}

export function deriveRepoId(repoFullName: string): string {
  const repoName = repoFullName.split("/")[1]?.trim().toLowerCase() ?? "";
  const normalized = repoName
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  if (!normalized) {
    throw new UsageError(`Could not derive a repo id from ${repoFullName}. Pass an explicit <id>.`, "repo");
  }
  return normalized;
}

export function parseAttachTarget(parsed: ParsedArgs): { repoId: string; repoFullName: string } {
  const first = parsed.positionals[1];
  const second = parsed.positionals[2];
  if (!first) {
    throw new UsageError("review-quill attach requires <owner/repo> or <id> <owner/repo>.", "repo");
  }
  if (second) {
    return { repoId: first, repoFullName: second };
  }
  if (!first.includes("/")) {
    throw new UsageError("review-quill attach requires <owner/repo> or <id> <owner/repo>.", "repo");
  }

  return { repoId: deriveRepoId(first), repoFullName: first };
}

export function rewriteParsedArgs(parsed: ParsedArgs, positionals: string[]): ParsedArgs {
  return {
    positionals,
    flags: parsed.flags,
  };
}
