import type { AppConfig } from "../types.ts";
import type { OperatorFeedEvent } from "../operator-feed.ts";

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

export interface OperatorFeedResult {
  events: OperatorFeedEvent[];
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
      projectId: string;
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
  listOperatorFeed(options?: { limit?: number; issueKey?: string; projectId?: string }): Promise<OperatorFeedResult>;
  followOperatorFeed(
    onEvent: (event: OperatorFeedEvent) => void,
    options?: { limit?: number; issueKey?: string; projectId?: string },
  ): Promise<void>;
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

  async listOperatorFeed(options?: { limit?: number; issueKey?: string; projectId?: string }): Promise<OperatorFeedResult> {
    return await this.requestJson<OperatorFeedResult>("/api/feed", {
      ...(options?.limit && options.limit > 0 ? { limit: String(options.limit) } : {}),
      ...(options?.issueKey ? { issue: options.issueKey } : {}),
      ...(options?.projectId ? { project: options.projectId } : {}),
    });
  }

  async followOperatorFeed(
    onEvent: (event: OperatorFeedEvent) => void,
    options?: { limit?: number; issueKey?: string; projectId?: string },
  ): Promise<void> {
    const url = new URL("/api/feed", this.getOperatorBaseUrl());
    url.searchParams.set("follow", "1");
    if (options?.limit && options.limit > 0) {
      url.searchParams.set("limit", String(options.limit));
    }
    if (options?.issueKey) {
      url.searchParams.set("issue", options.issueKey);
    }
    if (options?.projectId) {
      url.searchParams.set("project", options.projectId);
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...(this.config.operatorApi.bearerToken ? { authorization: `Bearer ${this.config.operatorApi.bearerToken}` } : {}),
      },
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      const message = this.readErrorMessage(body);
      throw new Error(message ?? `Request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (!line) {
          if (dataLines.length > 0) {
            const parsed = JSON.parse(dataLines.join("\n")) as OperatorFeedEvent;
            onEvent(parsed);
            dataLines = [];
          }
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith(":")) {
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
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
