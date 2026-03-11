import type { Logger } from "pino";
import type { LinearInstallationStoreProvider } from "./installation-ports.ts";
import { createLinearOAuthUrl, createOAuthStateToken, installLinearOAuthCode } from "./linear-oauth.ts";
import type { AppConfig, LinearInstallationRecord } from "./types.ts";

const LINEAR_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function oauthStateExpired(createdAt: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  return !Number.isFinite(createdAtMs) || createdAtMs + LINEAR_OAUTH_STATE_TTL_MS < Date.now();
}

export class LinearOAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly stores: LinearInstallationStoreProvider,
    private readonly logger: Logger,
  ) {}

  createStart(params?: { projectId?: string }) {
    if (params?.projectId && !this.config.projects.some((project) => project.id === params.projectId)) {
      throw new Error(`Unknown project: ${params.projectId}`);
    }

    if (params?.projectId) {
      const existingLink = this.stores.linearInstallations.getProjectInstallation(params.projectId);
      if (existingLink) {
        const installation = this.stores.linearInstallations.getLinearInstallation(existingLink.installationId);
        if (installation) {
          return {
            completed: true as const,
            reusedExisting: true as const,
            projectId: params.projectId,
            installation: this.getInstallationSummary(installation),
          };
        }
      }

      const installations = this.stores.linearInstallations.listLinearInstallations();
      if (installations.length === 1) {
        const installation = installations[0];
        if (installation) {
          this.stores.linearInstallations.linkProjectInstallation(params.projectId, installation.id);
          return {
            completed: true as const,
            reusedExisting: true as const,
            projectId: params.projectId,
            installation: this.getInstallationSummary(installation),
          };
        }
      }
    }

    const state = createOAuthStateToken();
    const record = this.stores.linearInstallations.createOAuthState({
      provider: "linear",
      state,
      redirectUri: this.config.linear.oauth.redirectUri,
      actor: this.config.linear.oauth.actor,
      ...(params?.projectId ? { projectId: params.projectId } : {}),
    });
    return {
      state,
      authorizeUrl: createLinearOAuthUrl(this.config, record.state, record.redirectUri, record.projectId),
      redirectUri: record.redirectUri,
      ...(record.projectId ? { projectId: record.projectId } : {}),
    };
  }

  async complete(params: { state: string; code: string }): Promise<LinearInstallationRecord> {
    const oauthState = this.stores.linearInstallations.getOAuthState(params.state);
    if (!oauthState || oauthState.consumedAt) {
      throw new Error("OAuth state was not found or has already been consumed");
    }
    if (oauthStateExpired(oauthState.createdAt)) {
      this.stores.linearInstallations.finalizeOAuthState({
        state: params.state,
        status: "failed",
        errorMessage: "OAuth state expired",
      });
      throw new Error("OAuth state has expired. Start the connection flow again.");
    }

    try {
      const installation = await installLinearOAuthCode({
        config: this.config,
        db: this.stores.linearInstallations,
        logger: this.logger,
        code: params.code,
        redirectUri: oauthState.redirectUri,
        ...(oauthState.projectId ? { projectId: oauthState.projectId } : {}),
      });
      this.stores.linearInstallations.finalizeOAuthState({
        state: params.state,
        status: "completed",
        installationId: installation.id,
      });
      return installation;
    } catch (error) {
      this.stores.linearInstallations.finalizeOAuthState({
        state: params.state,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getStateStatus(state: string) {
    const oauthState = this.stores.linearInstallations.getOAuthState(state);
    if (!oauthState) {
      return undefined;
    }

    const installation =
      oauthState.installationId !== undefined ? this.stores.linearInstallations.getLinearInstallation(oauthState.installationId) : undefined;
    return {
      state: oauthState.state,
      status: oauthState.status,
      ...(oauthState.projectId ? { projectId: oauthState.projectId } : {}),
      ...(installation ? { installation: this.getInstallationSummary(installation) } : {}),
      ...(oauthState.errorMessage ? { errorMessage: oauthState.errorMessage } : {}),
    };
  }

  listInstallations(): Array<{ installation: ReturnType<LinearOAuthService["getInstallationSummary"]>; linkedProjects: string[] }> {
    const links = this.stores.linearInstallations.listProjectInstallations();
    return this.stores.linearInstallations.listLinearInstallations().map((installation) => ({
      installation: this.getInstallationSummary(installation),
      linkedProjects: links.filter((link) => link.installationId === installation.id).map((link) => link.projectId),
    }));
  }

  getInstallationSummary(installation: LinearInstallationRecord) {
    return {
      id: installation.id,
      ...(installation.workspaceName ? { workspaceName: installation.workspaceName } : {}),
      ...(installation.workspaceKey ? { workspaceKey: installation.workspaceKey } : {}),
      ...(installation.actorName ? { actorName: installation.actorName } : {}),
      ...(installation.actorId ? { actorId: installation.actorId } : {}),
      ...(installation.expiresAt ? { expiresAt: installation.expiresAt } : {}),
    };
  }
}
