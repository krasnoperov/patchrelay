import type { DiscoveredRepoSettings } from "./github-repo-discovery.ts";

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

export interface ServiceErrorResponse {
  ok: false;
  error: string;
}
