import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Unified GitHub App credential delivery for `git` and the `gh` CLI used by the
 * review agent.
 *
 * review-quill spawns a long-lived, shared Codex app-server whose agent issues its own
 * `git`/`gh` commands. We can't inject credentials per-command into those, so the agent
 * authenticates through a private `gh` config directory (`GH_CONFIG_DIR`) whose
 * `hosts.yml` holds the current App installation token. `git` is pointed at
 * `gh auth git-credential` via env-injected config, so it reads the same token. The
 * token file is rewritten on every proactive rotation, so even the long-lived agent
 * re-reads a fresh token on each call rather than one frozen at spawn.
 *
 * Critically, this replaces the agent's previous fallback to the *operator's* personal
 * `gh`/`git` credentials: with `GH_TOKEN`/`GITHUB_TOKEN` stripped from the child and
 * `GH_CONFIG_DIR` pointing at the bot config, the agent authenticates as the App
 * (`review-quill[bot]`), not the human running the host. Nothing is written into any
 * repo/global git config.
 */

export const GITHUB_HOST = "github.com";

export interface GitHubBotIdentity {
  /** e.g. "review-quill[bot]" */
  name: string;
  /** noreply email, e.g. "12345+review-quill[bot]@users.noreply.github.com" */
  email: string;
}

/** Path to the per-service `gh` config directory, under the service data dir. */
export function getGhConfigDir(dataDir: string): string {
  return path.join(dataDir, "gh-bot");
}

/** Resolve an absolute `gh` path so the git credential helper works under restricted PATHs. */
export function resolveGhBin(): string {
  for (const candidate of ["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "gh";
}

/**
 * Write `gh`'s `hosts.yml` so that `gh` (and therefore `git`, via
 * `gh auth git-credential`) authenticate as the App using `token`.
 */
export async function writeGhHostsToken(
  ghConfigDir: string,
  token: string,
  login: string,
): Promise<void> {
  await mkdir(ghConfigDir, { recursive: true });
  const hosts =
    `${GITHUB_HOST}:\n` +
    `    oauth_token: ${token}\n` +
    `    user: ${login}\n` +
    `    git_protocol: https\n`;
  await writeFile(path.join(ghConfigDir, "hosts.yml"), hosts, { mode: 0o600 });
}

/**
 * Build the environment that makes both `gh` and `git` authenticate as the App.
 *
 * - `GH_CONFIG_DIR` points `gh` at the rotated bot config.
 * - `git` delegates github.com credentials to `gh auth git-credential` (an empty
 *   helper first clears any inherited/global helper, then ours is appended).
 * - `GIT_AUTHOR_*`/`GIT_COMMITTER_*` attribute commits to the bot without writing
 *   `user.name` into any repo config.
 */
export function buildGitHubCliAuthEnv(opts: {
  ghConfigDir: string;
  ghBin: string;
  identity?: GitHubBotIdentity;
}): Record<string, string> {
  const env: Record<string, string> = {
    GH_CONFIG_DIR: opts.ghConfigDir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `credential.https://${GITHUB_HOST}.helper`,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: `credential.https://${GITHUB_HOST}.helper`,
    GIT_CONFIG_VALUE_1: `!${opts.ghBin} auth git-credential`,
  };
  if (opts.identity) {
    env.GIT_AUTHOR_NAME = opts.identity.name;
    env.GIT_AUTHOR_EMAIL = opts.identity.email;
    env.GIT_COMMITTER_NAME = opts.identity.name;
    env.GIT_COMMITTER_EMAIL = opts.identity.email;
  }
  return env;
}

/** Apply {@link buildGitHubCliAuthEnv} onto a process env object in place. */
export function applyGitHubCliAuthEnv(
  target: NodeJS.ProcessEnv,
  opts: { ghConfigDir: string; ghBin: string; identity?: GitHubBotIdentity },
): void {
  Object.assign(target, buildGitHubCliAuthEnv(opts));
}

/**
 * Build the environment for the long-lived Codex agent child. `GH_TOKEN`/`GITHUB_TOKEN`
 * are stripped so the agent resolves credentials through the inherited `GH_CONFIG_DIR`
 * (re-read fresh on each call) instead of a token frozen at spawn — and so it can never
 * fall back to the operator's personal token. The child still inherits the `gh`
 * credential helper and bot identity.
 */
export function buildAgentChildEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}
