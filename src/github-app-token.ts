import { createSign } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { resolveSecretWithSource, type SecretSource } from "./resolve-secret.ts";
import { getPatchRelayDataDir } from "./runtime-paths.ts";

const TOKEN_REFRESH_MS = 30 * 60_000; // 30 minutes (tokens last 1 hour)

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  /** Pre-resolved installation ID for the app. Avoids an API call per refresh. */
  installationId?: string;
}

export interface GitHubAppBotIdentity {
  name: string;   // e.g. "patchrelay[bot]"
  email: string;  // e.g. "267939867+patchrelay[bot]@users.noreply.github.com"
  tokenFile: string; // Path to the App installation token file for git push auth
}

export interface GitHubAppTokenManager {
  /** Start the background refresh loop. */
  start(): Promise<void>;
  /** Stop the background loop. */
  stop(): void;
  /** Read the current token (from the file), or undefined if not available. */
  currentToken(): string | undefined;
  /** Bot identity for git config (resolved on first token refresh). */
  botIdentity(): GitHubAppBotIdentity | undefined;
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

/**
 * Well-known paths for the token file and the gh wrapper.
 */
export function getGitHubAppPaths() {
  const shareDir = getPatchRelayDataDir();
  return {
    tokenFile: path.join(shareDir, "gh-token"),
    binDir: path.join(shareDir, "bin"),
    ghWrapper: path.join(shareDir, "bin", "gh"),
  };
}

/**
 * Create the gh wrapper script that reads the token file.
 * Idempotent — safe to call on every startup.
 */
export async function ensureGhWrapper(logger: Logger): Promise<void> {
  const { binDir, ghWrapper, tokenFile } = getGitHubAppPaths();
  await mkdir(binDir, { recursive: true });

  const script = `#!/bin/bash
# PatchRelay gh wrapper — uses GitHub App token when available.
# Falls through to the user's own gh auth if the token file is missing.
TOKEN_FILE="${tokenFile}"
if [ -f "$TOKEN_FILE" ]; then
  export GH_TOKEN=$(cat "$TOKEN_FILE")
fi
exec /usr/bin/gh "$@"
`;

  await writeFile(ghWrapper, script, { mode: 0o755 });
  logger.debug({ path: ghWrapper }, "Wrote gh wrapper script");
}

/**
 * Generate a GitHub App JWT (RS256, 10-minute lifetime).
 */
function generateJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60, // 60s clock drift allowance
    exp: now + 600, // 10 minutes
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
async function fetchInstallationToken(jwt: string, installationId: string): Promise<string> {
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
  const data = await response.json() as { token: string };
  return data.token;
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
 * Creates a token manager that writes a fresh GitHub App installation token
 * to a well-known file every 30 minutes. The gh wrapper script reads this file.
 *
 * Returns undefined if credentials are not configured (optional feature).
 */
export function createGitHubAppTokenManager(
  credentials: GitHubAppCredentials,
  logger: Logger,
): GitHubAppTokenManager {
  const { tokenFile } = getGitHubAppPaths();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvedInstallationId: string | undefined = credentials.installationId;
  let cachedToken: string | undefined;
  let resolvedBotIdentity: GitHubAppBotIdentity | undefined;

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

      const token = await fetchInstallationToken(jwt, resolvedInstallationId);
      await mkdir(path.dirname(tokenFile), { recursive: true });
      await writeFile(tokenFile, token, { mode: 0o600 });
      cachedToken = token;
      logger.debug("Refreshed GitHub App installation token");
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to refresh GitHub App token (will retry in 30 minutes)",
      );
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
      return cachedToken;
    },
    botIdentity() {
      return resolvedBotIdentity;
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

  const { tokenFile } = getGitHubAppPaths();
  return {
    name: user.login,
    email: `${user.id}+${user.login}@users.noreply.github.com`,
    tokenFile,
  };
}
