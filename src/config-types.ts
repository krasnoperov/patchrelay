import type { ProjectConfig } from "./workflow-types.ts";

export interface CodexAppServerConfig {
  bin: string;
  args: string[];
  shellBin?: string;
  sourceBashrc?: boolean;
  requestTimeoutMs?: number;
  model?: string;
  modelProvider?: string;
  serviceName?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  sandboxMode: "danger-full-access" | "workspace-write" | "read-only";
  persistExtendedHistory: boolean;
}

export interface AppConfig {
  server: {
    bind: string;
    port: number;
    publicBaseUrl?: string;
    healthPath: string;
    readinessPath: string;
  };
  ingress: {
    linearWebhookPath: string;
    githubWebhookPath: string;
    maxBodyBytes: number;
    maxTimestampSkewSeconds: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    format: "logfmt";
    filePath: string;
  };
  database: {
    path: string;
    wal: boolean;
  };
  linear: {
    webhookSecret: string;
    graphqlUrl: string;
    oauth: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      scopes: string[];
      actor: "user" | "app";
    };
    tokenEncryptionKey: string;
  };
  operatorApi: {
    enabled: boolean;
    bearerToken?: string;
  };
  runner: {
    gitBin: string;
    codex: CodexAppServerConfig;
  };
  projects: ProjectConfig[];
}
