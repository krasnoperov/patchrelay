import type { HelpTopic } from "./types.ts";

function rootHelpText(): string {
  return [
    "merge-steward",
    "",
    "merge-steward is a repo-scoped merge queue service for PatchRelay-managed pull requests.",
    "",
    "Usage:",
    "  merge-steward <command> [args] [flags]",
    "",
    "Happy path:",
    "  1. merge-steward init <public-base-url>",
    "  2. merge-steward attach <id> <owner/repo> [--base-branch main] [--required-check test,lint]",
    "  3. merge-steward doctor --repo <id>",
    "  4. merge-steward service status <id>",
    "  5. merge-steward queue status --repo <id>",
    "",
    "Everyday commands:",
    "  attach <id> <owner/repo> [--base-branch <branch>] [--required-check <checks>] [--label <label>] [--json]",
    "                                                          Create or update one repo-scoped steward config and restart its service",
    "  repos [<id>] [--json]                                  List attached repositories or show one repo config and webhook URL",
    "  doctor [--repo <id>] [--json]                          Validate config, secrets, auth, and required binaries",
    "  service status <id> [--json]                           Show systemd state for one repo instance",
    "  service logs <id> [--lines <count>] [--json]           Show recent journal logs for one repo instance",
    "  queue status --repo <id> [--json]                      Show queue summary and current entries",
    "  queue show --repo <id> (--entry <id> | --pr <num>) [--events <count>] [--json]",
    "                                                          Show one queue entry with events and incidents",
    "  queue watch --repo <id> [--pr <number>]                Open the queue watch TUI",
    "",
    "Service management:",
    "  service install [--force] [--json]                     Reinstall the systemd instance unit template",
    "  service restart <id> [--json]                          Reload-or-restart one repo instance",
    "Advanced commands:",
    "  init <public-base-url> [--force] [--json]              Bootstrap the local merge-steward home and systemd template",
    "  serve [--config <path> | --repo <id>]                  Run the service",
    "  queue reconcile --repo <id> [--json]                   Ask the local service to reconcile immediately",
    "",
    "Secrets:",
    "  - MERGE_STEWARD_WEBHOOK_SECRET or systemd credential `merge-steward-webhook-secret`",
    "  - MERGE_STEWARD_GITHUB_TOKEN or systemd credential `merge-steward-github-token`",
    "",
    "Command help:",
    "  merge-steward help",
    "  merge-steward help repos",
    "  merge-steward help service",
    "  merge-steward help queue",
  ].join("\n");
}

function reposHelpText(): string {
  return [
    "Usage:",
    "  merge-steward attach <id> <owner/repo> [options]",
    "  merge-steward repos [<id>] [--json]",
    "",
    "Options for `attach`:",
    "  --base-branch <branch>       Base branch to land into (default: main)",
    "  --required-check <checks>    Comma-separated required check names",
    "  --label <label>              Admission label (default: queue)",
    "  --json                       Emit structured JSON",
    "",
    "Examples:",
    "  merge-steward attach app owner/repo --base-branch main --required-check test,lint",
    "  merge-steward repos",
    "  merge-steward repos app",
  ].join("\n");
}

function serviceHelpText(): string {
  return [
    "Usage:",
    "  merge-steward service <command> [args] [options]",
    "",
    "Commands:",
    "  install [--force] [--json]    Reinstall the systemd instance unit template",
    "  restart <id> [--json]         Reload-or-restart one repo instance",
    "  status <id> [--json]          Show systemd state for one repo instance",
    "  logs <id> [--lines <count>] [--json]",
    "                                Show recent journal logs for one repo instance",
  ].join("\n");
}

function queueHelpText(): string {
  return [
    "Usage:",
    "  merge-steward queue <command> [options]",
    "",
    "Commands:",
    "  status --repo <id>                                 Show queue summary and entries",
    "  show --repo <id> (--entry <id> | --pr <num>)       Show one queue entry with events and incidents",
    "  watch --repo <id> [--pr <number>]                  Open the queue watch TUI",
    "  reconcile --repo <id> [--json]                     Ask the local service to reconcile immediately",
  ].join("\n");
}

export function helpTextFor(topic: HelpTopic): string {
  switch (topic) {
    case "repos":
      return reposHelpText();
    case "service":
      return serviceHelpText();
    case "queue":
      return queueHelpText();
    default:
      return rootHelpText();
  }
}
