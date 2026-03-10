import crypto from "node:crypto";
import type { Logger } from "pino";
import { PatchRelayDatabase } from "./db.js";
import { encryptSecret } from "./token-crypto.js";
import type { AppConfig, LinearInstallationRecord, LinearOauthTokenSet } from "./types.js";

const DEFAULT_LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const DEFAULT_LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

export interface LinearViewerIdentity {
  workspaceId?: string;
  workspaceName?: string;
  workspaceKey?: string;
  actorId?: string;
  actorName?: string;
}

export function createOAuthStateToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function createLinearOAuthUrl(
  config: AppConfig,
  state: string,
  redirectUri?: string,
  _projectId?: string,
): string {
  if (!config.linear.oauth) {
    throw new Error("Linear OAuth is not configured");
  }

  const url = new URL(DEFAULT_LINEAR_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.linear.oauth.clientId);
  url.searchParams.set("redirect_uri", redirectUri ?? config.linear.oauth.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.linear.oauth.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("actor", config.linear.oauth.actor);
  return url.toString();
}

export async function exchangeLinearOAuthCode(
  config: AppConfig,
  params: {
    code: string;
    redirectUri: string;
  },
): Promise<LinearOauthTokenSet> {
  if (!config.linear.oauth) {
    throw new Error("Linear OAuth is not configured");
  }

  const response = await fetch(DEFAULT_LINEAR_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: params.code,
      client_id: config.linear.oauth.clientId,
      client_secret: config.linear.oauth.clientSecret,
      redirect_uri: params.redirectUri,
    }),
  });

  const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!response.ok || !payload) {
    throw new Error(`Linear OAuth code exchange failed with HTTP ${response.status}`);
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token : undefined;
  if (!accessToken) {
    throw new Error("Linear OAuth response did not include access_token");
  }

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
  return {
    accessToken,
    ...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    scopes:
      typeof payload.scope === "string"
        ? payload.scope.split(/[,\s]+/).filter(Boolean)
        : config.linear.oauth.scopes,
  };
}

export async function refreshLinearOAuthToken(
  config: AppConfig,
  refreshToken: string,
): Promise<LinearOauthTokenSet> {
  if (!config.linear.oauth) {
    throw new Error("Linear OAuth is not configured");
  }

  const response = await fetch(DEFAULT_LINEAR_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.linear.oauth.clientId,
      client_secret: config.linear.oauth.clientSecret,
    }),
  });

  const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!response.ok || !payload) {
    throw new Error(`Linear OAuth token refresh failed with HTTP ${response.status}`);
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token : undefined;
  if (!accessToken) {
    throw new Error("Linear OAuth refresh response did not include access_token");
  }

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
  return {
    accessToken,
    ...(typeof payload.refresh_token === "string" ? { refreshToken: payload.refresh_token } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    scopes:
      typeof payload.scope === "string"
        ? payload.scope.split(/[,\s]+/).filter(Boolean)
        : config.linear.oauth.scopes,
  };
}

export async function fetchLinearViewerIdentity(
  graphqlUrl: string,
  accessToken: string,
  logger: Logger,
): Promise<LinearViewerIdentity> {
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `
        query PatchRelayLinearViewer {
          viewer {
            id
            name
          }
          teams {
            nodes {
              id
              name
              key
            }
          }
        }
      `,
    }),
  });

  const payload = (await response.json().catch(() => undefined)) as
    | {
        data?: {
          viewer?: { id?: string | null; name?: string | null } | null;
          teams?: {
            nodes?: Array<{ id?: string | null; name?: string | null; key?: string | null }>;
          } | null;
        };
        errors?: Array<{ message?: string }>;
      }
    | undefined;
  if (!response.ok || !payload?.data) {
    throw new Error(`Linear viewer lookup failed with HTTP ${response.status}`);
  }

  const teams = payload.data.teams?.nodes ?? [];
  const firstTeam = teams.find((team) => team?.id || team?.name || team?.key);

  const result: LinearViewerIdentity = {
    ...(firstTeam?.id ? { workspaceId: firstTeam.id } : {}),
    ...(firstTeam?.name ? { workspaceName: firstTeam.name } : {}),
    ...(firstTeam?.key ? { workspaceKey: firstTeam.key } : {}),
    ...(payload.data.viewer?.id ? { actorId: payload.data.viewer.id } : {}),
    ...(payload.data.viewer?.name ? { actorName: payload.data.viewer.name } : {}),
  };

  logger.debug(
    {
      workspaceId: result.workspaceId,
      workspaceName: result.workspaceName,
      actorId: result.actorId,
      actorName: result.actorName,
    },
    "Resolved Linear OAuth identity",
  );

  return result;
}

export async function installLinearOAuthCode(params: {
  config: AppConfig;
  db: PatchRelayDatabase;
  logger: Logger;
  code: string;
  redirectUri: string;
  projectId?: string;
}): Promise<LinearInstallationRecord> {
  if (!params.config.linear.oauth || !params.config.linear.tokenEncryptionKey) {
    throw new Error("Linear OAuth is not configured");
  }

  const tokenSet = await exchangeLinearOAuthCode(params.config, {
    code: params.code,
    redirectUri: params.redirectUri,
  });
  const identity = await fetchLinearViewerIdentity(params.config.linear.graphqlUrl, tokenSet.accessToken, params.logger);
  const installation = params.db.upsertLinearInstallation({
    ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
    ...(identity.workspaceName ? { workspaceName: identity.workspaceName } : {}),
    ...(identity.workspaceKey ? { workspaceKey: identity.workspaceKey } : {}),
    ...(identity.actorId ? { actorId: identity.actorId } : {}),
    ...(identity.actorName ? { actorName: identity.actorName } : {}),
    accessTokenCiphertext: encryptSecret(tokenSet.accessToken, params.config.linear.tokenEncryptionKey),
    ...(tokenSet.refreshToken
      ? { refreshTokenCiphertext: encryptSecret(tokenSet.refreshToken, params.config.linear.tokenEncryptionKey) }
      : {}),
    scopesJson: JSON.stringify(tokenSet.scopes),
    ...(tokenSet.tokenType ? { tokenType: tokenSet.tokenType } : { tokenType: "Bearer" }),
    ...(tokenSet.expiresAt ? { expiresAt: tokenSet.expiresAt } : {}),
  });

  if (params.projectId) {
    params.db.linkProjectInstallation(params.projectId, installation.id);
  }

  return installation;
}
