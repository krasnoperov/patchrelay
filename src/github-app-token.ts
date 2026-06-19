import { createSign } from "node:crypto";
import type { Logger } from "pino";
import { resolveSecretWithSource, type SecretSource } from "./resolve-secret.ts";
import { getPatchRelayDataDir } from "./runtime-paths.ts";
import { getGhConfigDir, writeGhHostsToken, type GitHubBotIdentity } from "./github-cli-auth.ts";

const TOKEN_REFRESH_MS = 30 * 60_000; // 30 minutes (installation tokens last 1 hour)
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000; // treat a token expiring within 5 min as stale
const GITHUB_APP_JWT_MAX_LIFETIME_SECONDS = 10 * 60;
const GITHUB_APP_JWT_CLOCK_SKEW_SECONDS = 60;

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  /** Pre-resolved installation ID for the app. Avoids an API call per refresh. */
  installationId?: string;
}

/** Re-exported for callers that attribute commits to the bot. */
export type GitHubAppBotIdentity = GitHubBotIdentity;

export interface GitHubAppAuthStatus {
  /** True when a fresh installation token is currently available. */
  healthy: boolean;
  installationId: string | null;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  consecutiveFailures: number;
  expiresAt: string | null;
}

export interface GitHubAppTokenManager {
  /** Start the background refresh loop (initial refresh runs synchronously). */
  start(): Promise<void>;
  /** Stop the background loop. */
  stop(): void;
  /** Read the current token (from memory), or undefined if not available/fresh. */
  currentToken(): string | undefined;
  /** Force a re-mint + hosts.yml rotation (e.g. after an observed auth failure). */
  refresh(): Promise<void>;
  /** Bot identity for git commit attribution (resolved on first token refresh). */
  botIdentity(): GitHubAppBotIdentity | undefined;
  /** Current auth health, for readiness reporting and escalation. */
  authStatus(): GitHubAppAuthStatus;
}

/**
 * Resolve credentials from environment. Returns undefined if not configured.
 *
 * The private key is resolved via the provider-agnostic `resolveSecret`:
 *   1. `$CREDENTIALS_DIRECTORY/github-app-pem`  (systemd-creds)
 *   2. `$PATCHRELAY_GITHUB_APP_PRIVATE_KEY_FILE` (explicit file path)
 *   3. `$PATCHRELAY_GITHUB_APP_PRIVATE_KEY`      (direct env var)
 */
export function resolveGitHubAppCredentials(): (GitHubAppCredentials & { secretSources: Record<string, SecretSource> }) | undefined {
  const appId = process.env.PATCHRELAY_GITHUB_APP_ID;
  const rPrivateKey = resolveSecretWithSource("github-app-pem", "PATCHRELAY_GITHUB_APP_PRIVATE_KEY");
  const rWebhookSecret = resolveSecretWithSource("github-app-webhook-secret", "GITHUB_APP_WEBHOOK_SECRET");
  if (!appId || !rPrivateKey.value) return undefined;
  const installationId = process.env.PATCHRELAY_GITHUB_APP_INSTALLATION_ID;
  return {
    appId,
    privateKey: rPrivateKey.value,
    ...(installationId ? { installationId } : {}),
    secretSources: {
      "github-app-pem": rPrivateKey.source,
      ...(rWebhookSecret.value ? { "github-app-webhook-secret": rWebhookSecret.source } : {}),
    },
  };
}

/** Well-known path for the per-service `gh` config directory (holds the rotated hosts.yml). */
export function getGitHubAppPaths() {
  return { ghConfigDir: getGhConfigDir(getPatchRelayDataDir()) };
}

/**
 * Generate a GitHub App JWT (RS256, 10-minute lifetime).
 */
export function generateJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - GITHUB_APP_JWT_CLOCK_SKEW_SECONDS,
    exp: now + GITHUB_APP_JWT_MAX_LIFETIME_SECONDS - GITHUB_APP_JWT_CLOCK_SKEW_SECONDS,
    iss: appId,
  })).toString("base64url");

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

/**
 * Exchange a JWT for an installation access token (1-hour lifetime).
 */
async function fetchInstallationToken(jwt: string, installationId: string): Promise<{ token: string; expiresAt: string | null }> {
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch installation token (${response.status}): ${body}`);
  }
  const data = await response.json() as { token: string; expires_at?: string };
  return { token: data.token, expiresAt: data.expires_at ?? null };
}

/**
 * Find the first installation ID for this app. Called once if installationId
 * is not pre-configured.
 */
async function resolveInstallationId(jwt: string): Promise<string> {
  const response = await fetch("https://api.github.com/app/installations", {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to list installations (${response.status}): ${body}`);
  }
  const installations = await response.json() as Array<{ id: number }>;
  const first = installations[0];
  if (!first) {
    throw new Error("GitHub App has no installations. Install it on a repository first.");
  }
  return String(first.id);
}

/**
 * Creates a token manager that proactively re-mints a GitHub App installation token
 * every 30 minutes and rewrites `gh`'s `hosts.yml` so both `gh` and `git` (via
 * `gh auth git-credential`) authenticate as the bot with an always-fresh token.
 *
 * `onRefreshResult` is invoked after every refresh attempt so the service can update
 * readiness/health and escalate when auth breaks.
 */
export function createGitHubAppTokenManager(
  credentials: GitHubAppCredentials,
  logger: Logger,
  onRefreshResult?: (status: GitHubAppAuthStatus) => void,
): GitHubAppTokenManager {
  const { ghConfigDir } = getGitHubAppPaths();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvedInstallationId: string | undefined = credentials.installationId;
  let cachedToken: string | undefined;
  let expiresAtMs: number | undefined;
  let resolvedBotIdentity: GitHubAppBotIdentity | undefined;
  let lastRefreshAt: string | null = null;
  let lastRefreshError: string | null = null;
  let consecutiveFailures = 0;

  function isFresh(): boolean {
    if (!cachedToken) return false;
    if (expiresAtMs === undefined) return true;
    return expiresAtMs - Date.now() > TOKEN_EXPIRY_MARGIN_MS;
  }

  function status(): GitHubAppAuthStatus {
    return {
      healthy: isFresh() && lastRefreshError === null,
      installationId: resolvedInstallationId ?? null,
      lastRefreshAt,
      lastRefreshError,
      consecutiveFailures,
      expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    };
  }

  async function refresh(): Promise<void> {
    try {
      const jwt = generateJwt(credentials.appId, credentials.privateKey);

      if (!resolvedInstallationId) {
        resolvedInstallationId = await resolveInstallationId(jwt);
        logger.info({ installationId: resolvedInstallationId }, "Resolved GitHub App installation ID");
      }

      if (!resolvedBotIdentity) {
        resolvedBotIdentity = await resolveBotIdentity(jwt);
        logger.info({ botName: resolvedBotIdentity.name, botEmail: resolvedBotIdentity.email }, "Resolved GitHub App bot identity");
      }

      const { token, expiresAt } = await fetchInstallationToken(jwt, resolvedInstallationId);
      await writeGhHostsToken(ghConfigDir, token, resolvedBotIdentity.name);
      // Keep the daemon's own env token fresh for in-process consumers that read it
      // directly (webhook API helpers). This is the daemon's process env only — never a
      // repo/global git config — and is stripped from the long-lived Codex child, which
      // reads the rotated hosts.yml via GH_CONFIG_DIR instead.
      process.env.GH_TOKEN = token;
      process.env.GITHUB_TOKEN = token;
      cachedToken = token;
      expiresAtMs = expiresAt ? Date.parse(expiresAt) : undefined;
      lastRefreshAt = new Date().toISOString();
      lastRefreshError = null;
      consecutiveFailures = 0;
      logger.info(
        { installationId: resolvedInstallationId, expiresAt, ghConfigDir },
        "Rotated GitHub App token (gh + git now authenticate as the bot with a fresh token)",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastRefreshError = message;
      consecutiveFailures += 1;
      // Escalate: a broken App token means every git/gh operation will fail.
      logger.error(
        { error: message, consecutiveFailures, installationId: resolvedInstallationId ?? null },
        "Failed to refresh GitHub App token — gh/git auth is degraded until this recovers",
      );
    } finally {
      onRefreshResult?.(status());
    }
  }

  function schedule(): void {
    timer = setTimeout(() => {
      void refresh().finally(schedule);
    }, TOKEN_REFRESH_MS);
    timer.unref?.();
  }

  return {
    async start() {
      await refresh();
      schedule();
    },
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    currentToken() {
      return isFresh() ? cachedToken : undefined;
    },
    async refresh() {
      await refresh();
    },
    botIdentity() {
      return resolvedBotIdentity;
    },
    authStatus() {
      return status();
    },
  };
}

/**
 * Resolve the bot user identity (name + noreply email) from the GitHub API.
 * The bot user ID (not the App ID) is required for the noreply email —
 * using the App ID causes the [bot] badge to not render on commits.
 */
async function resolveBotIdentity(jwt: string): Promise<GitHubAppBotIdentity> {
  const response = await fetch("https://api.github.com/app", {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch app info (${response.status}): ${body}`);
  }
  const app = await response.json() as { slug: string };
  const botLogin = `${app.slug}[bot]`;

  // Fetch the bot user to get the user ID (different from App ID)
  const userResponse = await fetch(`https://api.github.com/users/${encodeURIComponent(botLogin)}`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!userResponse.ok) {
    const body = await userResponse.text();
    throw new Error(`Failed to fetch bot user ${botLogin} (${userResponse.status}): ${body}`);
  }
  const user = await userResponse.json() as { id: number; login: string };

  return {
    name: user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
  };
}
