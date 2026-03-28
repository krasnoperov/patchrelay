export type CliHelpTopic = "root" | "repos" | "issue" | "service";

export function rootHelpText(): string {
  return [
    "PatchRelay",
    "",
    "Mental model:",
    "  PatchRelay is a local service that owns repos, runs issues inside those repos,",
    "  and exposes service/auth/operator controls around that loop.",
    "",
    "Usage:",
    "  patchrelay <command> [args] [flags]",
    "",
    "Happy path:",
    "  1. patchrelay init <public-https-url>",
    "  2. Fill in ~/.config/patchrelay/service.env",
    "  3. patchrelay attach <id>             # run from the repo root, or pass --path /path/to/repo",
    "  4. Add IMPLEMENTATION_WORKFLOW.md and REVIEW_WORKFLOW.md to the repo",
    "  5. patchrelay doctor",
    "  6. patchrelay service status",
    "",
    "Core commands:",
    "  init <public-base-url> [--force] [--json]               Bootstrap the machine-level PatchRelay home",
    "  doctor [--json]                                         Check secrets, paths, git, codex, and service reachability",
    "  attach <id> [path] [--path <path>] [--prefix <prefixes>] [--team <ids>] [--no-auth] [--no-open] [--timeout <seconds>] [--json]",
    "                                                          Attach one local repository and prepare Linear auth when ready",
    "  repos [<id>] [--json]                                   List attached repositories or show one attached repository",
    "  issue list [--active] [--failed] [--repo <id>] [--json]",
    "                                                          List tracked issues",
    "  issue show <issueKey> [--json]                          Show the latest known issue state",
    "  issue watch <issueKey> [--json]                         Follow the active run until it settles",
    "  issue open <issueKey> [--print] [--json]                Open Codex in the issue worktree",
    "  service status [--json]                                 Show systemd state and local health",
    "  service logs [--lines <count>] [--json]                 Show recent service logs",
    "",
    "Operator commands:",
    "  connect [--repo <id>] [--no-open] [--timeout <seconds>] [--json]",
    "                                                          Start or reuse a Linear installation directly",
    "  installations [--json]                                  Show connected Linear installations",
    "  feed [--follow] [--limit <count>] [--issue <issueKey>] [--repo <id>] [--kind <kind>] [--stage <stage>] [--status <status>] [--workflow <id>] [--json]",
    "                                                          Show operator activity from the daemon",
    "  dashboard [--issue <issueKey>]                           Open the TUI dashboard of issues and runs",
    "  serve                                                   Run the local PatchRelay service",
    "",
    "Environment options:",
    "  --help, -h              Show help for the root command or current command group",
    "",
    "Automation env vars:",
    "  PATCHRELAY_CONFIG       Override the config file path",
    "  PATCHRELAY_DB_PATH      Override the SQLite database path",
    "  PATCHRELAY_LOG_FILE     Override the log file path",
    "  PATCHRELAY_LOG_LEVEL    Override the log level",
    "",
    "Examples:",
    "  patchrelay init https://patchrelay.example.com",
    "  patchrelay attach app",
    "  patchrelay attach app --path /absolute/path/to/repo",
    "  patchrelay repos",
    "  patchrelay issue list --active",
    "  patchrelay issue watch USE-54",
    "  patchrelay dashboard",
    "  patchrelay service status",
    "  patchrelay version --json",
    "",
    "Command help:",
    "  patchrelay help",
    "  patchrelay help repos",
    "  patchrelay help issue",
    "  patchrelay help service",
  ].join("\n");
}

export function reposHelpText(): string {
  return [
    "Usage:",
    "  patchrelay attach <id> [path] [options]",
    "  patchrelay repos [<id>] [--json]",
    "",
    "Options for `attach`:",
    "  --path <path>              Override the repository path instead of using the current working tree",
    "  --prefix <prefixes>        Comma-separated issue key prefixes for routing",
    "  --team <ids>               Comma-separated Linear team ids for routing",
    "  --no-auth                  Save the repo without starting or reusing Linear OAuth",
    "  --no-open                  Do not open the browser during connect",
    "  --timeout <seconds>        Override the connect wait timeout",
    "  --json                     Emit structured JSON output",
    "  --help, -h                 Show this help",
    "",
    "Behavior:",
    "  `patchrelay attach` is the idempotent happy-path command. It defaults to",
    "  the current working tree when `[path]` is omitted, updates the local config,",
    "  reruns readiness checks, reloads the service when ready, and reuses or starts",
    "  the Linear connect flow unless `--no-auth` is set.",
    "",
    "Examples:",
    "  patchrelay attach app",
    "  patchrelay attach app --prefix APP",
    "  patchrelay attach app --path /absolute/path/to/repo --team team-123 --no-auth",
    "  patchrelay repos",
    "  patchrelay repos app",
  ].join("\n");
}

export function issueHelpText(): string {
  return [
    "Usage:",
    "  patchrelay issue <command> [args] [options]",
    "",
    "Commands:",
    "  show <issueKey>                 Show the latest known issue state",
    "  list                            List tracked issues",
    "  watch <issueKey>                Follow the active run until it settles",
    "  report <issueKey>               Show finished run reports",
    "  events <issueKey>               Show raw thread events",
    "  path <issueKey>                 Print the issue worktree path",
    "  open <issueKey>                 Open Codex in the issue worktree",
    "  retry <issueKey>                Requeue a run",
    "",
    "Examples:",
    "  patchrelay issue list --active",
    "  patchrelay issue show USE-54",
    "  patchrelay issue watch USE-54",
  ].join("\n");
}

export function serviceHelpText(): string {
  return [
    "Usage:",
    "  patchrelay service <command> [options]",
    "",
    "Commands:",
    "  install [--force] [--write-only] [--json]  Reinstall the systemd service unit",
    "  restart [--json]                           Reload-or-restart the service",
    "  status [--json]                            Show systemd state and service health",
    "  logs [--lines <count>] [--json]            Show recent journal logs",
    "",
    "Examples:",
    "  patchrelay service install",
    "  patchrelay service status",
    "  patchrelay service logs --lines 100",
  ].join("\n");
}

export function helpTextFor(topic: CliHelpTopic): string {
  switch (topic) {
    case "repos":
      return reposHelpText();
    case "issue":
      return issueHelpText();
    case "service":
      return serviceHelpText();
    default:
      return rootHelpText();
  }
}
