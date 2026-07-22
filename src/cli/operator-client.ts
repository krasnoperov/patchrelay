import type { AppConfig } from "../types.ts";
import { normalizeLocalServiceHost } from "./local-service-url.ts";

export interface InstallationListResult {
  installations: Array<{
    installation: {
      id: number;
      workspaceName?: string;
      workspaceKey?: string;
      actorName?: string;
      actorId?: string;
      expiresAt?: string;
      healthStatus?: string;
      healthReason?: string;
      healthUpdatedAt?: string;
    };
    linkedProjects: string[];
  }>;
}

export interface LinearWorkspaceListResult {
  workspaces: Array<{
    installation: {
      id: number;
      workspaceName?: string;
      workspaceKey?: string;
      actorName?: string;
      actorId?: string;
      expiresAt?: string;
      healthStatus?: string;
      healthReason?: string;
      healthUpdatedAt?: string;
    };
    linkedRepos: string[];
    teams: Array<{ id: string; key?: string; name?: string }>;
    projects: Array<{ id: string; name?: string; teamIds: string[] }>;
  }>;
}

export type ConnectResult =
  | {
      state: string;
      authorizeUrl: string;
      redirectUri: string;
      projectId?: string;
    }
  | {
      completed: true;
      reusedExisting: true;
      projectId?: string;
      installation: {
        id: number;
        workspaceName?: string;
        workspaceKey?: string;
        actorName?: string;
        actorId?: string;
        healthStatus?: string;
        healthReason?: string;
        healthUpdatedAt?: string;
      };
    };

export interface ConnectStateResult {
  state: string;
  status: "pending" | "completed" | "failed";
  projectId?: string;
  installation?: {
    id: number;
    workspaceName?: string;
    workspaceKey?: string;
    actorName?: string;
    actorId?: string;
    healthStatus?: string;
    healthReason?: string;
    healthUpdatedAt?: string;
  };
  errorMessage?: string;
}

export interface OperatorIssueStatusResult {
  issue: {
    issueKey?: string;
    title?: string;
    currentLinearState?: string;
    sessionState?: string;
    phase?: string;
    prNumber?: number;
    prState?: string;
    prReviewState?: string;
    prCheckStatus?: string;
    waitingReason?: string;
    statusNote?: string;
  };
  activeRun?: {
    id: number;
    runType: string;
    status: string;
    startedAt: string;
    threadId?: string;
  };
  latestRun?: {
    id: number;
    runType: string;
    status: string;
    startedAt: string;
    endedAt?: string;
  };
  liveThread?: {
    threadId: string;
    threadStatus: string;
    latestTurnId?: string;
    latestTurnStatus?: string;
    latestAgentMessage?: string;
    latestPlan?: string;
    activeCommand?: string;
    commandCount: number;
    fileChangeCount: number;
    toolCallCount: number;
  };
  latestReportSummary?: {
    latestAssistantMessage?: string | null;
    commandCount?: number;
    fileChangeCount?: number;
    toolCallCount?: number;
  };
  activity?: { at: string; kind?: string; summary?: string };
  codexError?: string;
  runs: Array<{ run: { id: number; runType: string; status: string; startedAt: string; endedAt?: string } }>;
  generatedAt: string;
}

export interface CliOperatorDataAccess {
  close(): void;
  connect(projectId?: string): Promise<ConnectResult>;
  connectStatus(state: string): Promise<ConnectStateResult>;
  promptIssue(issueKey: string, text: string): Promise<{ delivered: boolean; queued?: boolean }>;
  getIssueStatus(issueKey: string): Promise<OperatorIssueStatusResult>;
  listInstallations(): Promise<InstallationListResult>;
  listLinearWorkspaces(): Promise<LinearWorkspaceListResult>;
  syncLinearWorkspace(workspace?: string): Promise<{
    installation: LinearWorkspaceListResult["workspaces"][number]["installation"];
    teams: Array<{ id: string; key?: string; name?: string }>;
    projects: Array<{ id: string; name?: string; teamIds: string[] }>;
  }>;
  disconnectLinearWorkspace(workspace: string): Promise<{
    installation: LinearWorkspaceListResult["workspaces"][number]["installation"];
  }>;
}

export class CliOperatorApiClient implements CliOperatorDataAccess {
  constructor(protected readonly config: AppConfig) {}

  close(): void {}

  async connect(projectId?: string): Promise<ConnectResult> {
    const query = projectId ? { projectId } : undefined;
    return await this.requestJson<ConnectResult>("/api/oauth/linear/start", query);
  }

  async connectStatus(state: string): Promise<ConnectStateResult> {
    if (!state) {
      throw new Error("OAuth state is required.");
    }

    return await this.requestJson<ConnectStateResult>(`/api/oauth/linear/state/${encodeURIComponent(state)}`);
  }

  async promptIssue(issueKey: string, text: string): Promise<{ delivered: boolean; queued?: boolean }> {
    if (!issueKey.trim()) {
      throw new Error("Issue key is required.");
    }
    if (!text.trim()) {
      throw new Error("Prompt text is required.");
    }

    return await this.requestJson<{ delivered: boolean; queued?: boolean }>(
      `/api/issues/${encodeURIComponent(issueKey)}/prompt`,
      undefined,
      { method: "POST", body: { text } },
    );
  }

  async getIssueStatus(issueKey: string): Promise<OperatorIssueStatusResult> {
    if (!issueKey.trim()) throw new Error("Issue key is required.");
    return await this.requestJson<OperatorIssueStatusResult>(`/api/issues/${encodeURIComponent(issueKey)}/status`);
  }

  async listInstallations(): Promise<InstallationListResult> {
    return await this.requestJson<InstallationListResult>("/api/installations");
  }

  async listLinearWorkspaces(): Promise<LinearWorkspaceListResult> {
    return await this.requestJson<LinearWorkspaceListResult>("/api/linear/workspaces");
  }

  async syncLinearWorkspace(workspace?: string): Promise<{
    installation: LinearWorkspaceListResult["workspaces"][number]["installation"];
    teams: Array<{ id: string; key?: string; name?: string }>;
    projects: Array<{ id: string; name?: string; teamIds: string[] }>;
  }> {
    const query = workspace ? { workspace } : undefined;
    return await this.requestJson("/api/linear/workspaces/sync", query, { method: "POST" });
  }

  async disconnectLinearWorkspace(workspace: string): Promise<{
    installation: LinearWorkspaceListResult["workspaces"][number]["installation"];
  }> {
    return await this.requestJson(`/api/linear/workspaces/${encodeURIComponent(workspace)}`, undefined, { method: "DELETE" });
  }

  private getOperatorBaseUrl(): string {
    const host = normalizeLocalServiceHost(this.config.server.bind);
    return `http://${host}:${this.config.server.port}/`;
  }

  private async requestJson<T>(
    pathname: string,
    query?: Record<string, string | undefined>,
    init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown },
  ): Promise<T> {
    const url = new URL(pathname, this.getOperatorBaseUrl());
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        accept: "application/json",
        connection: "close",
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.config.operatorApi.bearerToken ? { authorization: `Bearer ${this.config.operatorApi.bearerToken}` } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const body = await response.text();
    if (!response.ok) {
      const message = this.readErrorMessage(body);
      throw new Error(message ?? `Request failed: ${response.status}`);
    }

    const parsed = JSON.parse(body) as { ok?: boolean } & T;
    if (parsed.ok === false) {
      throw new Error(this.readErrorMessage(body) ?? "Request failed.");
    }
    return parsed;
  }

  private readErrorMessage(body: string): string | undefined {
    try {
      const parsed = JSON.parse(body) as { message?: string; reason?: string };
      return parsed.message ?? parsed.reason;
    } catch {
      return undefined;
    }
  }
}
