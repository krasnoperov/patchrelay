import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import type { Logger } from "pino";
import { resolveSecretWithSource, type SecretSource } from "./resolve-secret.ts";

const TOKEN_REFRESH_MS = 30 * 60_000;
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;
const RECENT_AUTH_FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_AUTH_FAILURES_TO_KEEP = 50;

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  installationId?: string;
}

export interface ResolvedGitHubAppCredentials extends GitHubAppCredentials {
  secretSources: Record<string, SecretSource>;
}

export type GitHubAuthConfig =
  | { mode: "app"; credentials: ResolvedGitHubAppCredentials }
  | { mode: "none" };

export type GitHubAuthRefreshReason = "startup" | "scheduled" | "before_use" | "github_401" | "manual";

export interface GitHubInstallationAuthStatus {
  installationId: string;
  repoFullNames: string[];
  hasToken: boolean;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  fresh: boolean;
}

export interface GitHubAuthRuntimeStatus {
  ready: boolean;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  recentAuthFailureCount: number;
  lastAuthFailureAt: string | null;
  installations: GitHubInstallationAuthStatus[];
}

export interface RuntimeGitHubAuthProvider {
  currentTokenForRepo(repoFullName?: string): string | undefined;
  refreshTokenForRepo?(repoFullName: string, reason: GitHubAuthRefreshReason): Promise<void>;
  recordAuthFailure?(repoFullName: string, message: string): void;
}

export interface GitHubAppTokenManager extends RuntimeGitHubAuthProvider {
  start(): Promise<void>;
  stop(): void;
  refreshTokenForRepo(repoFullName: string, reason: GitHubAuthRefreshReason): Promise<void>;
  recordAuthFailure(repoFullName: string, message: string): void;
  authStatus(): GitHubAuthRuntimeStatus;
}

export function generateJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  })).toString("base64url");

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body}`);
  }
  return await response.json() as T;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function resolveAppSlug(credentials: GitHubAppCredentials): Promise<string> {
  const jwt = generateJwt(credentials.appId, credentials.privateKey);
  const data = await fetchJson<{ slug: string }>("https://api.github.com/app", { headers: githubHeaders(jwt) });
  return data.slug;
}

async function resolveInstallationIdForRepo(jwt: string, repoFullName: string): Promise<string> {
  const encodedRepo = repoFullName.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const data = await fetchJson<{ id: number }>(
    `https://api.github.com/repos/${encodedRepo}/installation`,
    { headers: githubHeaders(jwt) },
  );
  return String(data.id);
}

async function resolveFirstInstallationId(jwt: string): Promise<string> {
  const installations = await fetchJson<Array<{ id: number }>>(
    "https://api.github.com/app/installations",
    { headers: githubHeaders(jwt) },
  );
  const first = installations[0];
  if (!first) {
    throw new Error("GitHub App has no installations. Install it on at least one repository first.");
  }
  return String(first.id);
}

async function fetchInstallationToken(jwt: string, installationId: string): Promise<{ token: string; expiresAt?: string }> {
  const data = await fetchJson<{ token: string; expires_at?: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: githubHeaders(jwt) },
  );
  return {
    token: data.token,
    ...(typeof data.expires_at === "string" ? { expiresAt: data.expires_at } : {}),
  };
}

export async function issueGitHubAppToken(
  credentials: GitHubAppCredentials,
  options?: { repoFullName?: string },
): Promise<{ installationId: string; token: string }> {
  const jwt = generateJwt(credentials.appId, credentials.privateKey);
  const installationId = credentials.installationId
    ?? (options?.repoFullName
      ? await resolveInstallationIdForRepo(jwt, options.repoFullName)
      : await resolveFirstInstallationId(jwt));
  const { token } = await fetchInstallationToken(jwt, installationId);
  return { installationId, token };
}

export function resolveGitHubAppCredentials(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ResolvedGitHubAppCredentials | undefined {
  const appId = env.MERGE_STEWARD_GITHUB_APP_ID?.trim();
  const privateKey = resolveSecretWithSource("merge-steward-github-app-pem", "MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY", env);
  if (!appId || !privateKey.value) {
    return undefined;
  }
  const installationId = env.MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID?.trim() || undefined;
  return {
    appId,
    privateKey: privateKey.value,
    ...(installationId ? { installationId } : {}),
    secretSources: {
      "merge-steward-github-app-pem": privateKey.source,
    },
  };
}

export function resolveGitHubAuthConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): GitHubAuthConfig {
  const app = resolveGitHubAppCredentials(env);
  return app ? { mode: "app", credentials: app } : { mode: "none" };
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

export function createGitHubAppTokenManager(
  credentials: GitHubAppCredentials,
  repoFullNames: string[],
  logger: Logger,
): GitHubAppTokenManager {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const repoInstallationIds = new Map<string, string>();
  const installationTokens = new Map<string, {
    token: string;
    expiresAt?: string;
    lastRefreshAt: string;
    lastRefreshError: string | null;
  }>();
  const installationRefreshErrors = new Map<string, string>();
  const authFailures: Array<{ repoFullName: string; at: string; message: string }> = [];
  let lastRefreshAt: string | null = null;
  let lastRefreshError: string | null = null;

  function rememberInstallationRepo(installationId: string, repoFullName: string): void {
    repoInstallationIds.set(repoFullName, installationId);
  }

  function reposForInstallation(installationId: string): string[] {
    return repoFullNames.filter((repoFullName) =>
      (repoInstallationIds.get(repoFullName) ?? credentials.installationId) === installationId
    );
  }

  function isTokenFresh(token: { expiresAt?: string } | undefined): boolean {
    if (!token) return false;
    if (!token.expiresAt) return true;
    const expiresAtMs = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return false;
    return expiresAtMs - Date.now() > TOKEN_EXPIRY_MARGIN_MS;
  }

  function recordRefreshSuccess(installationId: string, token: { token: string; expiresAt?: string }): void {
    const refreshedAt = new Date().toISOString();
    installationTokens.set(installationId, {
      token: token.token,
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      lastRefreshAt: refreshedAt,
      lastRefreshError: null,
    });
    installationRefreshErrors.delete(installationId);
    lastRefreshAt = refreshedAt;
    lastRefreshError = null;
  }

  function recordRefreshFailure(installationId: string | undefined, message: string): void {
    lastRefreshError = message;
    if (!installationId) return;
    installationRefreshErrors.set(installationId, message);
    const existing = installationTokens.get(installationId);
    if (existing) {
      installationTokens.set(installationId, { ...existing, lastRefreshError: message });
    }
  }

  async function resolveInstallationForRepo(jwt: string, repoFullName: string): Promise<string> {
    const existing = repoInstallationIds.get(repoFullName) ?? credentials.installationId;
    if (existing) {
      rememberInstallationRepo(existing, repoFullName);
      return existing;
    }
    const installationId = await resolveInstallationIdForRepo(jwt, repoFullName);
    rememberInstallationRepo(installationId, repoFullName);
    logger.info({ repoFullName, installationId }, "Resolved GitHub App installation for repo");
    return installationId;
  }

  async function refreshInstallation(installationId: string, jwt: string, reason: GitHubAuthRefreshReason): Promise<void> {
    const token = await fetchInstallationToken(jwt, installationId);
    recordRefreshSuccess(installationId, token);
    // Transparency: every rotation is logged so operators can see gh/git auth staying fresh.
    logger.info(
      { installationId, expiresAt: token.expiresAt ?? null, reason },
      "Rotated GitHub App installation token (gh + git authenticate as the bot with a fresh token)",
    );
  }

  function escalateIfDegraded(): void {
    const status = authStatus();
    if (!status.ready) {
      logger.error(
        { lastRefreshError: status.lastRefreshError, installations: status.installations },
        "GitHub App auth is degraded — gh/git operations will fail until a fresh token is minted",
      );
    }
  }

  async function refresh(options?: { throwOnError?: boolean; reason?: GitHubAuthRefreshReason }): Promise<void> {
    const throwOnError = options?.throwOnError ?? false;
    const reason = options?.reason ?? "scheduled";
    try {
      const jwt = generateJwt(credentials.appId, credentials.privateKey);
      const installationIds = new Set<string>();

      if (credentials.installationId) installationIds.add(credentials.installationId);

      for (const repoFullName of repoFullNames) {
        const installationId = await resolveInstallationForRepo(jwt, repoFullName);
        installationIds.add(installationId);
      }

      for (const installationId of unique(installationIds)) {
        try {
          await refreshInstallation(installationId, jwt, reason);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordRefreshFailure(installationId, message);
          if (throwOnError) throw error;
          logger.warn({ installationId, error: message }, "Failed to refresh GitHub App installation token");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordRefreshFailure(undefined, message);
      if (throwOnError) throw new Error(`Failed to initialize GitHub App auth: ${message}`);
      logger.warn({ error: message }, "Failed to refresh GitHub App installation token");
    } finally {
      escalateIfDegraded();
    }
  }

  async function refreshTokenForRepo(repoFullName: string, reason: GitHubAuthRefreshReason): Promise<void> {
    const jwt = generateJwt(credentials.appId, credentials.privateKey);
    let installationId: string | undefined;
    try {
      installationId = await resolveInstallationForRepo(jwt, repoFullName);
      await refreshInstallation(installationId, jwt, reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordRefreshFailure(installationId, message);
      logger.warn({ repoFullName, installationId, reason, error: message }, "Failed to refresh GitHub App installation token");
      throw error;
    }
  }

  function schedule(): void {
    timer = setTimeout(() => {
      void refresh().finally(schedule);
    }, TOKEN_REFRESH_MS);
    timer.unref?.();
  }

  function recentAuthFailures(): Array<{ repoFullName: string; at: string; message: string }> {
    const cutoff = Date.now() - RECENT_AUTH_FAILURE_WINDOW_MS;
    return authFailures.filter((entry) => Date.parse(entry.at) >= cutoff);
  }

  function currentTokenForRepo(repoFullName?: string): string | undefined {
    if (repoFullName) {
      const installationId = repoInstallationIds.get(repoFullName) ?? credentials.installationId;
      if (installationId) {
        const token = installationTokens.get(installationId);
        return token && isTokenFresh(token) ? token.token : undefined;
      }
    }
    if (credentials.installationId) {
      const token = installationTokens.get(credentials.installationId);
      return token && isTokenFresh(token) ? token.token : undefined;
    }
    const first = installationTokens.values().next();
    if (first.done) return undefined;
    const token = first.value;
    return isTokenFresh(token) ? token.token : undefined;
  }

  function authStatus(): GitHubAuthRuntimeStatus {
    const installationIds = unique([
      ...installationTokens.keys(),
      ...installationRefreshErrors.keys(),
      ...(credentials.installationId ? [credentials.installationId] : []),
      ...repoFullNames.flatMap((repoFullName) => {
        const installationId = repoInstallationIds.get(repoFullName);
        return installationId ? [installationId] : [];
      }),
    ]);
    const installations = installationIds.map((installationId) => {
      const token = installationTokens.get(installationId);
      const refreshError = token?.lastRefreshError ?? installationRefreshErrors.get(installationId) ?? null;
      return {
        installationId,
        repoFullNames: reposForInstallation(installationId),
        hasToken: Boolean(token),
        expiresAt: token?.expiresAt ?? null,
        lastRefreshAt: token?.lastRefreshAt ?? null,
        lastRefreshError: refreshError,
        fresh: isTokenFresh(token) && !refreshError,
      };
    });
    const failures = recentAuthFailures();
    const missingRepoToken = repoFullNames.some((repoFullName) => !currentTokenForRepo(repoFullName));
    const tokenRefreshFailing = installations.some((installation) => installation.lastRefreshError !== null && !installation.fresh);
    return {
      ready: !missingRepoToken && !tokenRefreshFailing,
      lastRefreshAt,
      lastRefreshError,
      recentAuthFailureCount: failures.length,
      lastAuthFailureAt: failures.at(-1)?.at ?? null,
      installations,
    };
  }

  return {
    async start() {
      await refresh({ throwOnError: true, reason: "startup" });
      schedule();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    currentTokenForRepo,
    async refreshTokenForRepo(repoFullName, reason) {
      await refreshTokenForRepo(repoFullName, reason);
    },
    recordAuthFailure(repoFullName, message) {
      authFailures.push({ repoFullName, message, at: new Date().toISOString() });
      if (authFailures.length > MAX_AUTH_FAILURES_TO_KEEP) {
        authFailures.splice(0, authFailures.length - MAX_AUTH_FAILURES_TO_KEEP);
      }
    },
    authStatus,
  };
}
