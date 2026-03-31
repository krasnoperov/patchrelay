import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import type { Logger } from "pino";
import { resolveSecretWithSource, type SecretSource } from "./resolve-secret.ts";

const TOKEN_REFRESH_MS = 30 * 60_000;

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

export interface RuntimeGitHubAuthProvider {
  currentTokenForRepo(repoFullName?: string): string | undefined;
}

export interface GitHubAppTokenManager extends RuntimeGitHubAuthProvider {
  start(): Promise<void>;
  stop(): void;
}

function generateJwt(appId: string, privateKey: string): string {
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

async function resolveInstallationIdForRepo(jwt: string, repoFullName: string): Promise<string> {
  const encodedRepo = repoFullName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
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

async function fetchInstallationToken(jwt: string, installationId: string): Promise<string> {
  const data = await fetchJson<{ token: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(jwt),
    },
  );
  return data.token;
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
  const token = await fetchInstallationToken(jwt, installationId);
  return { installationId, token };
}

export function resolveGitHubAppCredentials(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ResolvedGitHubAppCredentials | undefined {
  const appId = env.MERGE_STEWARD_GITHUB_APP_ID?.trim();
  const privateKey = resolveSecretWithSource(
    "merge-steward-github-app-pem",
    "MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY",
    env,
  );
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
  if (app) {
    return { mode: "app", credentials: app };
  }
  return { mode: "none" };
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
  const installationTokens = new Map<string, string>();

  async function refresh(options?: { throwOnError?: boolean }): Promise<void> {
    const throwOnError = options?.throwOnError ?? false;
    try {
      const jwt = generateJwt(credentials.appId, credentials.privateKey);
      const installationIds = new Set<string>();

      if (credentials.installationId) {
        installationIds.add(credentials.installationId);
      }

      for (const repoFullName of repoFullNames) {
        let installationId = repoInstallationIds.get(repoFullName) ?? credentials.installationId;
        if (!installationId) {
          installationId = await resolveInstallationIdForRepo(jwt, repoFullName);
          repoInstallationIds.set(repoFullName, installationId);
          logger.info({ repoFullName, installationId }, "Resolved GitHub App installation for repo");
        }
        installationIds.add(installationId);
      }

      for (const installationId of unique(installationIds)) {
        const token = await fetchInstallationToken(jwt, installationId);
        installationTokens.set(installationId, token);
      }

      if (installationTokens.size === 0 && !credentials.installationId && repoFullNames.length === 0) {
        logger.warn("GitHub App auth configured, but no repositories are attached yet");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (throwOnError) {
        throw new Error(`Failed to initialize GitHub App auth: ${message}`);
      }
      logger.warn({ error: message }, "Failed to refresh GitHub App installation token");
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
      await refresh({ throwOnError: true });
      schedule();
    },
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    currentTokenForRepo(repoFullName?: string) {
      if (repoFullName) {
        const installationId = repoInstallationIds.get(repoFullName) ?? credentials.installationId;
        if (installationId) {
          return installationTokens.get(installationId);
        }
      }
      if (credentials.installationId) {
        return installationTokens.get(credentials.installationId);
      }
      const first = installationTokens.values().next();
      return first.done ? undefined : first.value;
    },
  };
}
