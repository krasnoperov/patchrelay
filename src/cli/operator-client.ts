import type { AppConfig } from "../types.ts";

export interface InstallationListResult {
  installations: Array<{
    installation: {
      id: number;
      workspaceName?: string;
      workspaceKey?: string;
      actorName?: string;
      actorId?: string;
      expiresAt?: string;
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
  };
  errorMessage?: string;
}

export interface CliOperatorDataAccess {
  close(): void;
  connect(projectId?: string): Promise<ConnectResult>;
  connectStatus(state: string): Promise<ConnectStateResult>;
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
    return await this.requestJson<ConnectResult>("/api/oauth/linear/start", {
      ...(projectId ? { projectId } : {}),
    });
  }

  async connectStatus(state: string): Promise<ConnectStateResult> {
    if (!state) {
      throw new Error("OAuth state is required.");
    }

    return await this.requestJson<ConnectStateResult>(`/api/oauth/linear/state/${encodeURIComponent(state)}`);
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
    return await this.requestJson("/api/linear/workspaces/sync", {
      ...(workspace ? { workspace } : {}),
    }, { method: "POST" });
  }

  async disconnectLinearWorkspace(workspace: string): Promise<{
    installation: LinearWorkspaceListResult["workspaces"][number]["installation"];
  }> {
    return await this.requestJson(`/api/linear/workspaces/${encodeURIComponent(workspace)}`, undefined, { method: "DELETE" });
  }

  private getOperatorBaseUrl(): string {
    const host = this.normalizeLocalHost(this.config.server.bind);
    return `http://${host}:${this.config.server.port}/`;
  }

  private normalizeLocalHost(bind: string): string {
    if (bind === "0.0.0.0") {
      return "127.0.0.1";
    }
    if (bind === "::") {
      return "[::1]";
    }
    if (bind.includes(":") && !bind.startsWith("[")) {
      return `[${bind}]`;
    }
    return bind;
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
