import type { DiscoveredRepoSettings } from "./github-repo-discovery.ts";

export type RepoRuntimeState = "initializing" | "ready" | "failed";

export interface RepoRuntimeStatus {
  repoId: string;
  repoFullName: string;
  baseBranch: string;
  state: RepoRuntimeState;
  startedAt: string;
  readyAt?: string | undefined;
  failedAt?: string | undefined;
  lastError?: string | undefined;
}

export interface ServiceHealthResponse {
  ok: boolean;
  startupComplete: boolean;
  repos: RepoRuntimeStatus[];
}

export interface ServiceGitHubAuthStatus {
  mode: "none" | "app";
  configured: boolean;
  ready: boolean;
  webhookSecretConfigured: boolean;
  appId?: string;
  installationMode?: "pinned" | "per_repo";
  error?: string;
}

export interface ServiceGitHubDiscoverResponse {
  ok: true;
  discovery: DiscoveredRepoSettings;
}

export interface ServiceGitHubRepoAccessResponse {
  ok: true;
  repoFullName: string;
  baseBranch: string;
  permissions: {
    contents: "none" | "read" | "write";
    pull: boolean;
    push: boolean;
    admin: boolean;
  };
  branchProtected: boolean;
}

export interface ServiceErrorResponse {
  ok: false;
  error: string;
  code?: string;
}
