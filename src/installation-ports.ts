import type { LinearInstallationRecord, OAuthStateRecord, ProjectInstallationRecord } from "./types.ts";

export interface LinearInstallationStore {
  upsertLinearInstallation(params: {
    workspaceId?: string;
    workspaceName?: string;
    workspaceKey?: string;
    actorId?: string;
    actorName?: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext?: string | null;
    scopesJson: string;
    tokenType?: string;
    expiresAt?: string | null;
  }): LinearInstallationRecord;
  getLinearInstallationForProject(projectId: string): LinearInstallationRecord | undefined;
  listLinearInstallations(): LinearInstallationRecord[];
  listProjectInstallations(): ProjectInstallationRecord[];
  getProjectInstallation(projectId: string): ProjectInstallationRecord | undefined;
  getLinearInstallation(id: number): LinearInstallationRecord | undefined;
  linkProjectInstallation(projectId: string, installationId: number): ProjectInstallationRecord;
  createOAuthState(params: {
    provider: "linear";
    state: string;
    projectId?: string;
    redirectUri: string;
    actor: "user" | "app";
  }): OAuthStateRecord;
  getOAuthState(state: string): OAuthStateRecord | undefined;
  finalizeOAuthState(params: {
    state: string;
    status: "completed" | "failed";
    installationId?: number;
    errorMessage?: string;
  }): OAuthStateRecord | undefined;
}

export interface LinearInstallationStoreProvider {
  linearInstallations: LinearInstallationStore;
}
