import type { HelpTopic } from "./types.ts";

function rootHelpText(): string {
  return [
    "merge-steward",
    "",
    "merge-steward is a multi-repo merge queue service for GitHub pull requests.",
    "",
    "Usage:",
    "  merge-steward <command> [args] [flags]",
    "",
    "Happy path:",
    "  1. merge-steward init <public-base-url>",
    "  2. merge-steward repo attach <owner/repo>",
    "  3. merge-steward doctor --repo <id>",
    "  4. merge-steward service status",
    "  5. merge-steward queue status --repo <id>",
    "",
    "Everyday commands:",
    "  repo attach <owner/repo> [--base-branch <branch>] [--label <label>] [--refresh] [--json]",
    "                                                          Create or update a repo config, auto-discover GitHub defaults, and restart the service",
    "  repo list [--json]                                     List attached repositories",
    "  repo show <id> [--json]                                Show one repo config",
    "  doctor [--repo <id>] [--json]                          Validate config, secrets, auth, and required binaries",
    "  service status [--json]                                Show systemd state and local health",
    "  service logs [--lines <count>] [--json]                Show recent journal logs",
    "  pr status [--repo <id>] [--pr <num>] [--wait] [--timeout <s>] [--poll <s>] [--json]",
    "                                                          Classify a single PR; exit 0 terminal ok, 2 terminal failure, 3 still in flight, 4 --wait timeout",
    "  queue status [--repo <id>] [--cwd <path>] [--json]     Show queue summary and current entries",
    "  queue show [--repo <id>] (--entry <id> | --pr <num>) [--events <count>] [--json]",
    "                                                          Show one queue entry with events and incidents",
    "  dashboard [--repo <id>] [--pr <number>]                Open the multi-repo merge queue dashboard",
    "",
    "Resolution:",
    "  --repo and --pr are optional when you run the command inside a git",
    "  checkout. Without them, merge-steward reads `origin`'s remote URL,",
    "  matches it to an attached repoId, and uses `gh pr view` to find the",
    "  PR for the current branch. Pass --cwd <path> to resolve from a",
    "  specific directory instead of process.cwd().",
    "",
    "Exit codes (pr status):",
    "  0  merged / approved with green required checks",
    "  2  changes_requested / failing required checks / evicted / closed",
    "  3  still in flight (queued, preparing, validating, merging, pending)",
    "  4  --wait timed out before a terminal state was reached",
    "  1  usage or configuration error",
    "",
    "Service management:",
    "  service install [--force] [--json]                     Reinstall the systemd unit",
    "  service restart [--json]                               Reload-or-restart the service",
    "Advanced commands:",
    "  init <public-base-url> [--force] [--json]              Bootstrap the local merge-steward home and systemd unit",
    "  serve                                                  Run the service (all attached repos)",
    "  queue reconcile --repo <id> [--json]                   Ask the service to reconcile immediately",
    "",
    "Secrets:",
    "  - Service-owned webhook secret via systemd credential `merge-steward-webhook-secret`",
    "  - MERGE_STEWARD_GITHUB_APP_ID in service.env + systemd credential `merge-steward-github-app-pem`",
    "",
    "Command help:",
    "  merge-steward help",
    "  merge-steward help repo",
    "  merge-steward help service",
    "  merge-steward help queue",
  ].join("\n");
}

function repoHelpText(): string {
  return [
    "Usage:",
    "  merge-steward repo attach <owner/repo> [options]",
    "  merge-steward repo attach <id> <owner/repo> [options]",
    "  merge-steward repo list [--json]",
    "  merge-steward repo show <id> [--json]",
    "",
    "Options for `repo attach`:",
    "  --base-branch <branch>       Base branch to land into (default: main)",
    "  --label <label>              Admission label (default: queue)",
    "  --merge-queue-check-name <name>",
    "                               Eviction check run name (default: merge-steward/queue)",
    "  --refresh                    Re-discover the base branch from GitHub",
    "  --json                       Emit structured JSON",
    "",
    "Compatibility aliases:",
    "  merge-steward attach ...     Alias for `merge-steward repo attach ...`",
    "  merge-steward repos ...      Alias for `merge-steward repo list/show ...`",
    "",
    "Examples:",
    "  merge-steward repo attach owner/repo",
    "  merge-steward repo attach owner/repo --refresh",
    "  merge-steward repo attach owner/repo --label queue",
    "  merge-steward repo list",
    "  merge-steward repo show app",
  ].join("\n");
}

function serviceHelpText(): string {
  return [
    "Usage:",
    "  merge-steward service <command> [options]",
    "",
    "Commands:",
    "  install [--force] [--json]    Reinstall the systemd unit",
    "  restart [--json]              Reload-or-restart the service",
    "  status [--json]               Show systemd state and local health",
    "  logs [--lines <count>] [--json]",
    "                                Show recent journal logs",
  ].join("\n");
}

function queueHelpText(): string {
  return [
    "Usage:",
    "  merge-steward queue <command> [options]",
    "",
    "Commands:",
    "  dashboard [--repo <id>] [--pr <number>]            Open the multi-repo merge queue dashboard",
    "  status [--repo <id>] [--cwd <path>]                Show queue summary and entries",
    "  show [--repo <id>] (--entry <id> | --pr <num>)     Show one queue entry with events and incidents",
    "  reconcile [--repo <id>] [--cwd <path>] [--json]    Ask the service to reconcile immediately",
    "",
    "--repo is inferred from `origin`'s remote in the current git checkout.",
  ].join("\n");
}

export function helpTextFor(topic: HelpTopic): string {
  switch (topic) {
    case "repo":
    case "repos":
      return repoHelpText();
    case "service":
      return serviceHelpText();
    case "queue":
      return queueHelpText();
    default:
      return rootHelpText();
  }
}
