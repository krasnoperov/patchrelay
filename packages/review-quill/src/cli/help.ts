import type { Output } from "./shared.ts";
import { writeOutput } from "./shared.ts";
import type { HelpTopic } from "./args.ts";

function rootHelpText(): string {
  return [
    "review-quill",
    "",
    "Mental model:",
    "  review-quill is the PR review complement to PatchRelay and merge-steward.",
    "  It watches configured repositories, reviews merge-ready PR heads, and",
    "  publishes a normal GitHub PR review.",
    "",
    "Usage:",
    "  review-quill <command> [args] [flags]",
    "",
    "Happy path:",
    "  1. review-quill init <public-base-url>",
    "  2. Fill in ~/.config/review-quill/service.env",
    "  3. review-quill repo attach <owner/repo>",
    "  4. review-quill doctor --repo <id>",
    "  5. review-quill service status",
    "  6. review-quill dashboard",
    "",
    "Everyday commands:",
    "  init <public-base-url> [--force] [--json]              Bootstrap the local review-quill home and systemd unit",
    "  repo attach <owner/repo> [--base-branch <branch>] [--required-check <checks>] [--review-doc <paths>] [--refresh] [--json]",
    "                                                          Create or update a watched repository and restart the service",
    "  repo list [--json]                                     List watched repositories",
    "  repo show <id> [--json]                                Show one repo config",
    "  attempts <repo> <pr-number> [--json]                   Show recorded review attempts for one pull request",
    "  transcript <repo> <pr-number> [--attempt <id>] [--json]  Show the full visible Codex thread for one recorded review attempt",
    "  transcript-source <repo> <pr-number> [--attempt <id>] [--json]  Show the raw Codex session file for one review attempt",
    "  doctor [--repo <id>] [--json]                          Validate config, secrets, binaries, and service reachability",
    "  service status [--json]                                Show systemd state and local health",
    "  service logs [--lines <count>] [--json]                Show recent journal logs",
    "  dashboard [--config <path>]                            Open the review dashboard",
    "",
    "Service management:",
    "  service install [--force] [--json]                     Reinstall the systemd unit",
    "  service restart [--json]                               Reload-or-restart the service",
    "",
    "Advanced commands:",
    "  serve [--config <path>]                                Run the review-quill service",
    "  watch [--config <path>]                                Alias for `dashboard`",
    "  diff [--repo <id>] [--base <ref>] [--cwd <path>] [--ignore <globs>] [--summarize-only <globs>]",
    "       [--budget <tokens>] [--json]",
    "                                                          Render the diff/inventory the reviewer would see (debug view)",
    "                                                          (works in any git checkout; shows whatever state the caller prepared —",
    "                                                          never fetches, checks out, or mutates the working tree)",
    "  version                                                Show the installed CLI version",
    "",
    "Secrets:",
    "  - Service-owned webhook secret via systemd credential `review-quill-webhook-secret`",
    "  - REVIEW_QUILL_GITHUB_APP_ID in service.env + systemd credential `review-quill-github-app-pem`",
    "",
    "Review protocol:",
    "  - review-quill submits ordinary GitHub `APPROVE` / `REQUEST_CHANGES` reviews with its App identity",
    "",
    "Command help:",
    "  review-quill help",
    "  review-quill help repo",
    "  review-quill help service",
  ].join("\n");
}

function repoHelpText(): string {
  return [
    "Usage:",
    "  review-quill repo attach <owner/repo> [options]",
    "  review-quill repo attach <id> <owner/repo> [options]",
    "  review-quill repo list [--json]",
    "  review-quill repo show <id> [--json]",
    "",
    "Options for `repo attach`:",
    "  --base-branch <branch>       Base branch to review against (default: GitHub default branch or main)",
    "  --required-check <checks>    Comma-separated required check names",
    "  --review-doc <paths>         Comma-separated repo docs to provide to the reviewer",
    "  --refresh                    Re-discover base branch and required checks from GitHub",
    "  --json                       Emit structured JSON",
    "",
    "Compatibility aliases:",
    "  review-quill attach ...      Alias for `review-quill repo attach ...`",
    "  review-quill repos ...       Alias for `review-quill repo list/show ...`",
    "",
    "Examples:",
    "  review-quill repo attach krasnoperov/mafia",
    "  review-quill repo attach mafia krasnoperov/mafia --refresh",
    "  review-quill repo list",
    "  review-quill repo show mafia",
    "",
    "Review contract:",
    "  - review-quill leaves a descriptive APPROVE / REQUEST_CHANGES review on the PR timeline",
  ].join("\n");
}

function serviceHelpText(): string {
  return [
    "Usage:",
    "  review-quill service <command> [options]",
    "",
    "Commands:",
    "  install [--force] [--json]    Reinstall the systemd unit",
    "  restart [--json]              Reload-or-restart the service",
    "  status [--json]               Show systemd state and local health",
    "  logs [--lines <count>] [--json]",
    "                                Show recent journal logs",
  ].join("\n");
}

export function helpTextFor(topic: HelpTopic): string {
  switch (topic) {
    case "repo":
      return repoHelpText();
    case "service":
      return serviceHelpText();
    default:
      return rootHelpText();
  }
}

export function writeUsageError(stream: Output, error: { helpTopic: HelpTopic; message: string }): void {
  writeOutput(stream, `${helpTextFor(error.helpTopic)}\n\nError: ${error.message}\n`);
}
