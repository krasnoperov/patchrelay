import type { TriggerEvent } from "./workflow-types.ts";

export type LinearAction = "create" | "update" | "remove" | "created" | "prompted" | string;
export type LinearEntityType = "Issue" | "Comment" | "AgentSessionEvent" | string;

export interface LinearWebhookPayload {
  action: LinearAction;
  type: LinearEntityType;
  createdAt: string;
  webhookTimestamp: number;
  actor?: Record<string, unknown>;
  data?: Record<string, unknown>;
  updatedFrom?: Record<string, unknown>;
  url?: string;
}

export interface LinearActorMetadata {
  id?: string;
  name?: string;
  email?: string;
  type?: string;
}

export interface IssueMetadata {
  id: string;
  parentId?: string;
  parentIdentifier?: string;
  parentTitle?: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  attachments?: LinearIssueAttachment[];
  teamId?: string;
  teamKey?: string;
  stateId?: string;
  stateName?: string;
  stateType?: string;
  delegateId?: string;
  delegateName?: string;
  priority?: number;
  estimate?: number;
  relationsKnown?: boolean;
  labelNames: string[];
  blockedBy: LinearIssueRelationSummary[];
  blocks: LinearIssueRelationSummary[];
}

export interface CommentMetadata {
  id: string;
  body?: string;
  userName?: string;
}

export interface AgentSessionMetadata {
  id: string;
  promptContext?: string;
  promptBody?: string;
  issueCommentId?: string;
  signal?: string;
  signalMetadata?: Record<string, unknown>;
}

export interface InstallationWebhookMetadata {
  organizationId?: string;
  oauthClientId?: string;
  appUserId?: string;
  canAccessAllPublicTeams?: boolean;
  addedTeamIds: string[];
  removedTeamIds: string[];
  notificationType?: string;
}

export interface NormalizedEvent {
  webhookId: string;
  entityType: LinearEntityType;
  action: LinearAction;
  triggerEvent: TriggerEvent;
  eventType: string;
  actor?: LinearActorMetadata;
  issue?: IssueMetadata;
  comment?: CommentMetadata;
  agentSession?: AgentSessionMetadata;
  installation?: InstallationWebhookMetadata;
  payload: LinearWebhookPayload;
}

export interface LinearInstallationRecord {
  id: number;
  provider: "linear";
  workspaceId?: string;
  workspaceName?: string;
  workspaceKey?: string;
  actorId?: string;
  actorName?: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext?: string;
  webhookPathToken?: string;
  webhookSecretCiphertext?: string;
  scopesJson: string;
  tokenType?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInstallationRecord {
  projectId: string;
  installationId: number;
  linkedAt: string;
}

export interface LinearCatalogTeamRecord {
  installationId: number;
  teamId: string;
  key?: string;
  name?: string;
  active: boolean;
  updatedAt: string;
}

export interface LinearCatalogProjectRecord {
  installationId: number;
  projectId: string;
  name?: string;
  teamIdsJson: string;
  active: boolean;
  updatedAt: string;
}

export interface RepositoryLinkRecord {
  githubRepo: string;
  localPath: string;
  installationId: number;
  linearTeamIdsJson: string;
  linearProjectIdsJson: string;
  issueKeyPrefixesJson: string;
  linkedAt: string;
  updatedAt: string;
}

export interface OAuthStateRecord {
  id: number;
  provider: "linear";
  state: string;
  projectId?: string;
  redirectUri: string;
  actor: "user" | "app";
  createdAt: string;
  status: "pending" | "completed" | "failed";
  consumedAt?: string;
  installationId?: number;
  errorMessage?: string;
}

export interface LinearOauthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string[];
  tokenType?: string;
}

export interface LinearActorProfile {
  workspaceId?: string;
  workspaceName?: string;
  workspaceKey?: string;
  actorId?: string;
  actorName?: string;
}

export interface LinearWorkspaceCatalog {
  workspace: LinearActorProfile;
  teams: Array<{
    id: string;
    key?: string;
    name?: string;
  }>;
  projects: Array<{
    id: string;
    name?: string;
    teamIds: string[];
  }>;
}

export interface LinearIssueSnapshot {
  id: string;
  parentId?: string;
  parentIdentifier?: string;
  parentTitle?: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  attachments?: LinearIssueAttachment[];
  priority?: number;
  estimate?: number;
  stateId?: string;
  stateName?: string;
  stateType?: string;
  teamId?: string;
  teamKey?: string;
  delegateId?: string;
  delegateName?: string;
  workflowStates: Array<{
    id: string;
    name: string;
    type?: string;
  }>;
  labelIds: string[];
  labels: Array<{
    id: string;
    name: string;
  }>;
  teamLabels: Array<{
    id: string;
    name: string;
  }>;
  blockedBy: LinearIssueRelationSummary[];
  blocks: LinearIssueRelationSummary[];
}

export interface LinearIssueAttachment {
  id: string;
  title?: string;
  subtitle?: string;
  url: string;
}

export interface LinearIssueRelationSummary {
  id: string;
  identifier?: string;
  title?: string;
  stateId?: string;
  stateName?: string;
  stateType?: string;
}

export interface LinearCommentUpsertResult {
  id: string;
  body: string;
}

export type LinearAgentActivityContent =
  | { type: "thought" | "elicitation" | "response" | "error"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export interface LinearAgentActivityResult {
  id: string;
}

export interface LinearAgentSessionExternalUrl {
  label: string;
  url: string;
}

export interface LinearAgentSessionPlanItem {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface LinearAgentSessionUpdateResult {
  id: string;
}

export interface LinearClient {
  getIssue(issueId: string): Promise<LinearIssueSnapshot>;
  setIssueState(issueId: string, stateName: string): Promise<LinearIssueSnapshot>;
  upsertIssueComment(params: { issueId: string; commentId?: string; body: string }): Promise<LinearCommentUpsertResult>;
  createAgentActivity(params: {
    agentSessionId: string;
    content: LinearAgentActivityContent;
    ephemeral?: boolean;
  }): Promise<LinearAgentActivityResult>;
  updateAgentSession?(params: {
    agentSessionId: string;
    externalUrls?: LinearAgentSessionExternalUrl[];
    plan?: LinearAgentSessionPlanItem[];
  }): Promise<LinearAgentSessionUpdateResult>;
  updateIssueLabels(params: { issueId: string; addNames?: string[]; removeNames?: string[] }): Promise<LinearIssueSnapshot>;
  getActorProfile(): Promise<LinearActorProfile>;
  getWorkspaceCatalog(): Promise<LinearWorkspaceCatalog>;
}

export interface LinearClientProvider {
  forProject(projectId: string): Promise<LinearClient | undefined>;
}
