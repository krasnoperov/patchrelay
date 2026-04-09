import type { RunType } from "./factory-state.ts";
import type { SecretSource } from "./resolve-secret.ts";
import type { ProjectConfig } from "./workflow-types.ts";

export interface RepositoryConfig {
  githubRepo: string;
  localPath: string;
  workspace?: string;
  linearTeamIds: string[];
  linearProjectIds: string[];
  issueKeyPrefixes: string[];
}

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
  experimentalRawEvents?: boolean;
}

export interface PromptFileFragment {
  sourcePath: string;
  content: string;
}

export interface PromptCustomizationLayer {
  prepend: PromptFileFragment[];
  append: PromptFileFragment[];
  replaceSections: Record<string, PromptFileFragment>;
}

export interface PatchRelayPromptingConfig {
  default: PromptCustomizationLayer;
  byRunType: Partial<Record<RunType, PromptCustomizationLayer>>;
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
  prompting: PatchRelayPromptingConfig;
  repos: {
    root: string;
  };
  repositories: RepositoryConfig[];
  projects: ProjectConfig[];
  /** How each secret was resolved — for startup diagnostics. */
  secretSources: Record<string, SecretSource>;
}
