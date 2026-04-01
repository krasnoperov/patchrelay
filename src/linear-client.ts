import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import { refreshLinearOAuthToken } from "./linear-oauth.ts";
import { decryptSecret, encryptSecret } from "./token-crypto.ts";
import type {
  AppConfig,
  LinearAgentActivityContent,
  LinearAgentActivityResult,
  LinearActorProfile,
  LinearClient,
  LinearClientProvider,
  LinearCommentUpsertResult,
  LinearAgentSessionUpdateResult,
  LinearIssueSnapshot,
  LinearWorkspaceCatalog,
} from "./types.ts";

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{
    message?: string;
  }>;
}

interface LinearIssueRawFields {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  priority?: number | null;
  estimate?: number | null;
  delegate?: { id?: string | null; name?: string | null } | null;
  state?: { id?: string | null; name?: string | null } | null;
  labels?: { nodes?: Array<{ id: string; name: string }> } | null;
  blockedBy?: { nodes?: LinearIssueRelationRawFields[] } | null;
  blocks?: { nodes?: LinearIssueRelationRawFields[] } | null;
  team?: {
    id?: string | null;
    key?: string | null;
    states?: {
      nodes?: Array<{ id: string; name: string; type?: string | null }>;
    } | null;
    labels?: {
      nodes?: Array<{ id: string; name: string }>;
    } | null;
  } | null;
}

interface LinearIssueRelationRawFields {
  id: string;
  identifier?: string | null;
  title?: string | null;
  state?: {
    id?: string | null;
    name?: string | null;
    type?: string | null;
  } | null;
}

const LINEAR_ISSUE_SELECTION = `
  id
  identifier
  title
  description
  url
  priority
  estimate
  delegate {
    id
    name
  }
  state {
    id
    name
  }
  labels {
    nodes {
      id
      name
    }
  }
  blockedBy {
    nodes {
      id
      identifier
      title
      state {
        id
        name
        type
      }
    }
  }
  blocks {
    nodes {
      id
      identifier
      title
      state {
        id
        name
        type
      }
    }
  }
  team {
    id
    key
    states {
      nodes {
        id
        name
        type
      }
    }
    labels {
      nodes {
        id
        name
      }
    }
  }
`;

export class LinearGraphqlClient implements LinearClient {
  constructor(
    private readonly options: {
      accessToken: string;
      graphqlUrl: string;
    },
    private readonly logger: Logger,
  ) {}

  async getIssue(issueId: string): Promise<LinearIssueSnapshot> {
    const response = await this.request<{
      issue: LinearIssueRawFields | null;
    }>(
      `
      query PatchRelayIssue($id: String!) {
        issue(id: $id) {
          ${LINEAR_ISSUE_SELECTION}
        }
      }
      `,
      { id: issueId },
    );

    if (!response.issue) {
      throw new Error(`Linear issue ${issueId} was not found`);
    }

    return this.mapIssue(response.issue);
  }

  async setIssueState(issueId: string, stateName: string): Promise<LinearIssueSnapshot> {
    const issue = await this.getIssue(issueId);
    const state = issue.workflowStates.find((entry) => entry.name.trim().toLowerCase() === stateName.trim().toLowerCase());
    if (!state) {
      throw new Error(`Linear state "${stateName}" was not found for issue ${issue.identifier ?? issueId}`);
    }

    const response = await this.request<{
      issueUpdate: {
        success: boolean;
        issue?: LinearIssueRawFields | null;
      };
    }>(
      `
      mutation PatchRelaySetIssueState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue {
            ${LINEAR_ISSUE_SELECTION}
          }
        }
      }
      `,
      { id: issueId, stateId: state.id },
    );

    if (!response.issueUpdate.success || !response.issueUpdate.issue) {
      throw new Error(`Linear rejected state update for issue ${issue.identifier ?? issueId}`);
    }

    return this.mapIssue(response.issueUpdate.issue);
  }

  async upsertIssueComment(params: { issueId: string; commentId?: string; body: string }): Promise<LinearCommentUpsertResult> {
    if (params.commentId) {
      const response = await this.request<{
        commentUpdate: {
          success: boolean;
          comment?: { id: string; body: string } | null;
        };
      }>(
        `
        mutation PatchRelayUpdateComment($id: String!, $body: String!) {
          commentUpdate(id: $id, input: { body: $body }) {
            success
            comment {
              id
              body
            }
          }
        }
        `,
        { id: params.commentId, body: params.body },
      );

      if (response.commentUpdate.success && response.commentUpdate.comment) {
        return response.commentUpdate.comment;
      }
    }

    const response = await this.request<{
      commentCreate: {
        success: boolean;
        comment?: { id: string; body: string } | null;
      };
    }>(
      `
      mutation PatchRelayCreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
            body
          }
        }
      }
      `,
      { issueId: params.issueId, body: params.body },
    );

    if (!response.commentCreate.success || !response.commentCreate.comment) {
      throw new Error(`Linear rejected comment upsert for issue ${params.issueId}`);
    }

    return response.commentCreate.comment;
  }

  async createAgentActivity(params: {
    agentSessionId: string;
    content: LinearAgentActivityContent;
    ephemeral?: boolean;
  }): Promise<LinearAgentActivityResult> {
    const response = await this.request<{
      agentActivityCreate: {
        success: boolean;
        agentActivity?: { id: string } | null;
      };
    }>(
      `
      mutation PatchRelayCreateAgentActivity($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
          agentActivity {
            id
          }
        }
      }
      `,
      {
        input: {
          agentSessionId: params.agentSessionId,
          content: params.content,
          ephemeral: params.ephemeral ?? false,
        },
      },
    );

    if (!response.agentActivityCreate.success || !response.agentActivityCreate.agentActivity) {
      throw new Error(`Linear rejected agent activity for session ${params.agentSessionId}`);
    }

    return response.agentActivityCreate.agentActivity;
  }

  async updateAgentSession(params: {
    agentSessionId: string;
    externalUrls?: Array<{ label: string; url: string }>;
    plan?: Array<{ content: string; status: "pending" | "inProgress" | "completed" | "canceled" }>;
  }): Promise<LinearAgentSessionUpdateResult> {
    const input: Record<string, unknown> = {};
    if ("externalUrls" in params) {
      input.externalUrls = params.externalUrls;
    }
    if ("plan" in params) {
      input.plan = params.plan;
    }

    const response = await this.request<{
      agentSessionUpdate: {
        success: boolean;
        agentSession?: { id: string } | null;
      };
    }>(
      `
      mutation PatchRelayUpdateAgentSession($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) {
          success
          agentSession {
            id
          }
        }
      }
      `,
      {
        id: params.agentSessionId,
        input,
      },
    );

    if (!response.agentSessionUpdate.success || !response.agentSessionUpdate.agentSession) {
      throw new Error(`Linear rejected agent session update for session ${params.agentSessionId}`);
    }

    return response.agentSessionUpdate.agentSession;
  }

  async updateIssueLabels(params: { issueId: string; addNames?: string[]; removeNames?: string[] }): Promise<LinearIssueSnapshot> {
    const issue = await this.getIssue(params.issueId);
    const addIds = this.resolveLabelIds(issue, params.addNames ?? []);
    const removeIds = this.resolveLabelIds(issue, params.removeNames ?? []);
    if (addIds.length === 0 && removeIds.length === 0) {
      return issue;
    }

    const response = await this.request<{
      issueUpdate: {
        success: boolean;
        issue?: LinearIssueRawFields | null;
      };
    }>(
      `
      mutation PatchRelayUpdateIssueLabels($id: String!, $addedLabelIds: [String!], $removedLabelIds: [String!]) {
        issueUpdate(id: $id, input: { addedLabelIds: $addedLabelIds, removedLabelIds: $removedLabelIds }) {
          success
          issue {
            ${LINEAR_ISSUE_SELECTION}
          }
        }
      }
      `,
      {
        id: params.issueId,
        addedLabelIds: addIds,
        removedLabelIds: removeIds,
      },
    );

    if (!response.issueUpdate.success || !response.issueUpdate.issue) {
      throw new Error(`Linear rejected label update for issue ${issue.identifier ?? params.issueId}`);
    }

    return this.mapIssue(response.issueUpdate.issue);
  }

  async getActorProfile(): Promise<LinearActorProfile> {
    const response = await this.request<{
      viewer?: {
        id?: string | null;
        name?: string | null;
      } | null;
    }>(
      `
      query PatchRelayViewer {
        viewer {
          id
          name
        }
      }
      `,
      {},
    );

    return {
      ...(response.viewer?.id ? { actorId: response.viewer.id } : {}),
      ...(response.viewer?.name ? { actorName: response.viewer.name } : {}),
    };
  }

  async getWorkspaceCatalog(): Promise<LinearWorkspaceCatalog> {
    const response = await this.request<{
      organization?: {
        id?: string | null;
        name?: string | null;
        urlKey?: string | null;
      } | null;
      viewer?: {
        id?: string | null;
        name?: string | null;
      } | null;
      teams?: {
        nodes?: Array<{
          id: string;
          key?: string | null;
          name?: string | null;
        }>;
      } | null;
      projects?: {
        nodes?: Array<{
          id: string;
          name?: string | null;
          teams?: {
            nodes?: Array<{ id: string }>;
          } | null;
        }>;
      } | null;
    }>(
      `
      query PatchRelayWorkspaceCatalog {
        organization {
          id
          name
          urlKey
        }
        viewer {
          id
          name
        }
        teams {
          nodes {
            id
            key
            name
          }
        }
        projects {
          nodes {
            id
            name
            teams {
              nodes {
                id
              }
            }
          }
        }
      }
      `,
      {},
    );

    return {
      workspace: {
        ...(response.organization?.id ? { workspaceId: response.organization.id } : {}),
        ...(response.organization?.name ? { workspaceName: response.organization.name } : {}),
        ...(response.organization?.urlKey ? { workspaceKey: response.organization.urlKey } : {}),
        ...(response.viewer?.id ? { actorId: response.viewer.id } : {}),
        ...(response.viewer?.name ? { actorName: response.viewer.name } : {}),
      },
      teams: (response.teams?.nodes ?? []).map((team) => ({
        id: team.id,
        ...(team.key ? { key: team.key } : {}),
        ...(team.name ? { name: team.name } : {}),
      })),
      projects: (response.projects?.nodes ?? []).map((project) => ({
        id: project.id,
        ...(project.name ? { name: project.name } : {}),
        teamIds: (project.teams?.nodes ?? []).map((team) => team.id),
      })),
    };
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.options.graphqlUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.accessToken}`,
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    });

    if (!response.ok) {
      throw new Error(`Linear API request failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as GraphqlResponse<T>;
    if (payload.errors?.length) {
      const message = payload.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; ");
      this.logger.warn({ message }, "Linear GraphQL returned errors");
      throw new Error(message);
    }

    if (!payload.data) {
      throw new Error("Linear API returned no data");
    }

    return payload.data;
  }

  private mapIssue(issue: LinearIssueRawFields): LinearIssueSnapshot {
    const labels = (issue.labels?.nodes ?? []).map((label) => ({ id: label.id, name: label.name }));
    const teamLabels = (issue.team?.labels?.nodes ?? []).map((label) => ({ id: label.id, name: label.name }));
    return {
      id: issue.id,
      ...(issue.identifier ? { identifier: issue.identifier } : {}),
      ...(issue.title ? { title: issue.title } : {}),
      ...(issue.description ? { description: issue.description } : {}),
      ...(issue.url ? { url: issue.url } : {}),
      ...(issue.priority != null ? { priority: issue.priority } : {}),
      ...(issue.estimate != null ? { estimate: issue.estimate } : {}),
      ...(issue.state?.id ? { stateId: issue.state.id } : {}),
      ...(issue.state?.name ? { stateName: issue.state.name } : {}),
      ...(issue.team?.id ? { teamId: issue.team.id } : {}),
      ...(issue.team?.key ? { teamKey: issue.team.key } : {}),
      ...(issue.delegate?.id ? { delegateId: issue.delegate.id } : {}),
      ...(issue.delegate?.name ? { delegateName: issue.delegate.name } : {}),
      workflowStates: (issue.team?.states?.nodes ?? []).map((state) => ({
        id: state.id,
        name: state.name,
        ...(state.type ? { type: state.type } : {}),
      })),
      labelIds: labels.map((label) => label.id),
      labels,
      teamLabels,
      blockedBy: (issue.blockedBy?.nodes ?? []).map(mapIssueRelation),
      blocks: (issue.blocks?.nodes ?? []).map(mapIssueRelation),
    };
  }

  private resolveLabelIds(issue: LinearIssueSnapshot, names: string[]): string[] {
    const wanted = new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
    if (wanted.size === 0) {
      return [];
    }

    const labelIds = issue.teamLabels
      .filter((label) => wanted.has(label.name.trim().toLowerCase()))
      .map((label) => label.id);

    const missing = [...wanted].filter((name) => !issue.teamLabels.some((label) => label.name.trim().toLowerCase() === name));
    if (missing.length > 0) {
      this.logger.warn({ issueId: issue.id, missing }, "PatchRelay skipped missing configured Linear labels");
    }

    return labelIds;
  }
}

function mapIssueRelation(raw: LinearIssueRelationRawFields) {
  return {
    id: raw.id,
    ...(raw.identifier ? { identifier: raw.identifier } : {}),
    ...(raw.title ? { title: raw.title } : {}),
    ...(raw.state?.id ? { stateId: raw.state.id } : {}),
    ...(raw.state?.name ? { stateName: raw.state.name } : {}),
    ...(raw.state?.type ? { stateType: raw.state.type } : {}),
  };
}

export class DatabaseBackedLinearClientProvider implements LinearClientProvider {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
  ) {}

  async forProject(projectId: string): Promise<LinearClient | undefined> {
    const link = this.db.linearInstallations.getProjectInstallation(projectId);
    if (link) {
      return await this.forInstallationId(link.installationId);
    }
    return undefined;
  }

  async forInstallationId(installationId: number): Promise<LinearClient | undefined> {
    const installation = this.db.linearInstallations.getLinearInstallation(installationId);
    if (!installation) {
      return undefined;
    }

    const encryptionKey = this.config.linear.tokenEncryptionKey;
    let accessToken = decryptSecret(installation.accessTokenCiphertext, encryptionKey);
    const refreshToken = installation.refreshTokenCiphertext
      ? decryptSecret(installation.refreshTokenCiphertext, encryptionKey)
      : undefined;

    if (shouldRefreshToken(installation.expiresAt) && refreshToken) {
      const refreshed = await refreshLinearOAuthToken(this.config, refreshToken);
      accessToken = refreshed.accessToken;
      this.db.linearInstallations.updateLinearInstallationTokens(installation.id, {
        accessTokenCiphertext: encryptSecret(refreshed.accessToken, encryptionKey),
        ...(refreshed.refreshToken
          ? { refreshTokenCiphertext: encryptSecret(refreshed.refreshToken, encryptionKey) }
          : {}),
        scopesJson: JSON.stringify(refreshed.scopes),
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      });
    }

    return new LinearGraphqlClient(
      {
        accessToken,
        graphqlUrl: this.config.linear.graphqlUrl,
      },
      this.logger,
    );
  }
}

function shouldRefreshToken(expiresAt?: string): boolean {
  if (!expiresAt) {
    return false;
  }

  return Date.parse(expiresAt) <= Date.now() + 5 * 60 * 1000;
}
