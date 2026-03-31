export type CliHelpTopic = "root" | "linear" | "repo" | "issue" | "service";

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
    "  3. patchrelay linear connect",
    "  4. patchrelay linear sync",
    "  5. patchrelay repo link krasnoperov/usertold --workspace usertold --team USE",
    "  6. patchrelay doctor",
    "  7. patchrelay service status",
    "",
    "Core commands:",
    "  init <public-base-url> [--force] [--json]               Bootstrap the machine-level PatchRelay home",
    "  doctor [--json]                                         Check secrets, paths, git, codex, and service reachability",
    "  linear connect [--no-open] [--timeout <seconds>] [--json]  Connect PatchRelay to one Linear workspace",
    "  linear list [--json]                                      List connected Linear workspaces",
    "  linear sync [workspace] [--json]                          Refresh teams and projects from Linear",
    "  linear disconnect <workspace> [--json]                    Remove one connected Linear workspace",
    "  repo link <github-repo> --workspace <workspace> --team <team>[,...] [--project <project>[,...]] [--prefix <prefix>[,...]] [--path <path>] [--json]",
    "                                                            Link one GitHub repo to a Linear workspace/team and clone or reuse it locally",
    "  repo list [--json]                                        List linked repositories",
    "  repo show <github-repo> [--json]                          Show one linked repository",
    "  repo unlink <github-repo> [--json]                        Remove one linked repository",
    "  repo sync [github-repo] [--json]                          Clone missing repositories or fetch origin",
    "  issue list [--active] [--failed] [--repo <id>] [--json]",
    "                                                          List tracked issues",
    "  issue show <issueKey> [--json]                          Show the latest known issue state",
    "  issue watch <issueKey> [--json]                         Follow the active run until it settles",
    "  issue open <issueKey> [--print] [--json]                Open Codex in the issue worktree",
    "  service status [--json]                                 Show systemd state and local health",
    "  service logs [--lines <count>] [--json]                 Show recent service logs",
    "",
    "Operator commands:",
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
    "  patchrelay linear connect",
    "  patchrelay linear sync",
    "  patchrelay repo link krasnoperov/usertold --workspace usertold --team USE",
    "  patchrelay repo list",
    "  patchrelay issue list --active",
    "  patchrelay issue watch USE-54",
    "  patchrelay dashboard",
    "  patchrelay service status",
    "  patchrelay version --json",
    "",
    "Command help:",
    "  patchrelay help",
    "  patchrelay help linear",
    "  patchrelay help repo",
    "  patchrelay help issue",
    "  patchrelay help service",
  ].join("\n");
}

export function linearHelpText(): string {
  return [
    "Usage:",
    "  patchrelay linear connect [options]",
    "  patchrelay linear list [--json]",
    "  patchrelay linear sync [workspace] [--json]",
    "  patchrelay linear disconnect <workspace> [--json]",
    "",
    "Options for `linear connect`:",
    "  --no-open                  Do not open the browser during connect",
    "  --timeout <seconds>        Override the connect wait timeout",
    "  --json                     Emit structured JSON output",
    "  --help, -h                 Show this help",
    "",
    "Behavior:",
    "  `patchrelay linear connect` authorizes one Linear workspace for PatchRelay.",
    "  `patchrelay linear sync` refreshes that workspace's teams and projects.",
    "",
    "Examples:",
    "  patchrelay linear connect",
    "  patchrelay linear list",
    "  patchrelay linear sync usertold",
  ].join("\n");
}

export function repoHelpText(): string {
  return [
    "Usage:",
    "  patchrelay repo link <github-repo> --workspace <workspace> --team <team>[,...] [options]",
    "  patchrelay repo list [--json]",
    "  patchrelay repo show <github-repo> [--json]",
    "  patchrelay repo unlink <github-repo> [--json]",
    "  patchrelay repo sync [github-repo] [--json]",
    "",
    "Options for `repo link`:",
    "  --workspace <workspace>    Connected Linear workspace key/name/id",
    "  --team <team>[,...]        Linear team key, name, or id",
    "  --project <project>[,...]  Optional Linear project name or id",
    "  --prefix <prefix>[,...]    Optional issue key prefixes (defaults from team keys when available)",
    "  --path <path>              Override the managed local clone path",
    "  --json                     Emit structured JSON output",
    "  --help, -h                 Show this help",
    "",
    "Behavior:",
    "  `patchrelay repo link` uses the GitHub repo as the source of truth. It reuses",
    "  an existing local clone when origin matches, or clones into the managed repo root.",
    "",
    "Examples:",
    "  patchrelay repo link krasnoperov/usertold --workspace usertold --team USE",
    "  patchrelay repo show krasnoperov/usertold",
    "  patchrelay repo sync",
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
    case "linear":
      return linearHelpText();
    case "repo":
      return repoHelpText();
    case "issue":
      return issueHelpText();
    case "service":
      return serviceHelpText();
    default:
      return rootHelpText();
  }
}
