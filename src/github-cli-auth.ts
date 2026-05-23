import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Unified GitHub App credential delivery for `git` and the `gh` CLI.
 *
 * Both tools authenticate as the App through a single source of truth: a private
 * `gh` config directory (`GH_CONFIG_DIR`) whose `hosts.yml` holds the current
 * installation token. `git` is pointed at `gh auth git-credential` via env-injected
 * config, so it reads the same token. The token file is rewritten on every proactive
 * rotation (see github-app-token.ts), so even long-lived child processes (the Codex
 * app-server) stay fresh — they re-read the file on each call rather than capturing a
 * token frozen at spawn.
 *
 * Nothing is written into any repo/worktree/global git config, so these credentials
 * never leak into a developer's interactive shell sessions.
 */

export const GITHUB_HOST = "github.com";

export interface GitHubBotIdentity {
  /** e.g. "patchrelay[bot]" */
  name: string;
  /** numeric-id noreply, e.g. "267939867+patchrelay[bot]@users.noreply.github.com" */
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
 * - `GH_TOKEN`/`GITHUB_TOKEN` are returned as `undefined` (to be deleted): they take
 *   precedence over `GH_CONFIG_DIR` and would freeze a stale token on a long-lived
 *   process.
 */
export function buildGitHubCliAuthEnv(opts: {
  ghConfigDir: string;
  ghBin: string;
  identity?: GitHubBotIdentity;
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    GH_CONFIG_DIR: opts.ghConfigDir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `credential.https://${GITHUB_HOST}.helper`,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: `credential.https://${GITHUB_HOST}.helper`,
    GIT_CONFIG_VALUE_1: `!${opts.ghBin} auth git-credential`,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  };
  if (opts.identity) {
    env.GIT_AUTHOR_NAME = opts.identity.name;
    env.GIT_AUTHOR_EMAIL = opts.identity.email;
    env.GIT_COMMITTER_NAME = opts.identity.name;
    env.GIT_COMMITTER_EMAIL = opts.identity.email;
  }
  return env;
}

/**
 * Apply {@link buildGitHubCliAuthEnv} onto a process env object in place, deleting the
 * overriding `GH_TOKEN`/`GITHUB_TOKEN` so the rotated config dir is authoritative.
 */
export function applyGitHubCliAuthEnv(
  target: NodeJS.ProcessEnv,
  opts: { ghConfigDir: string; ghBin: string; identity?: GitHubBotIdentity },
): void {
  for (const [key, value] of Object.entries(buildGitHubCliAuthEnv(opts))) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
}
