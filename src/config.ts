import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppConfig } from "./types.ts";
import {
  getDefaultConfigPath,
  getDefaultDatabasePath,
  getDefaultLogPath,
  getDefaultRuntimeEnvPath,
  getDefaultServiceEnvPath,
  getPatchRelayDataDir,
} from "./runtime-paths.ts";
import { ensureAbsolutePath } from "./utils.ts";

const LINEAR_OAUTH_CALLBACK_PATH = "/oauth/linear/callback";

const workflowSchema = z.object({
  id: z.string().min(1),
  when_state: z.string().min(1),
  active_state: z.string().min(1),
  workflow_file: z.string().min(1),
  fallback_state: z.string().min(1).nullable().optional(),
});

const projectSchema = z.object({
  id: z.string().min(1),
  repo_path: z.string().min(1),
  worktree_root: z.string().min(1).optional(),
  workflows: z.array(workflowSchema).min(1).optional(),
  workflow_labels: z
    .object({
      working: z.string().min(1).optional(),
      awaiting_handoff: z.string().min(1).optional(),
    })
    .optional(),
  trusted_actors: z
    .object({
      ids: z.array(z.string().min(1)).default([]),
      names: z.array(z.string().min(1)).default([]),
      emails: z.array(z.string().email()).default([]),
      email_domains: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  issue_key_prefixes: z.array(z.string().min(1)).default([]),
  linear_team_ids: z.array(z.string().min(1)).default([]),
  allow_labels: z.array(z.string().min(1)).default([]),
  trigger_events: z.array(z.string().min(1)).min(1).optional(),
  branch_prefix: z.string().min(1).optional(),
});

const configSchema = z.object({
  server: z.object({
    bind: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(8787),
    public_base_url: z.string().url().optional(),
    health_path: z.string().default("/health"),
    readiness_path: z.string().default("/ready"),
  }),
  ingress: z.object({
    linear_webhook_path: z.string().default("/webhooks/linear"),
    max_body_bytes: z.number().int().positive().default(262144),
    max_timestamp_skew_seconds: z.number().int().positive().default(60),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    format: z.literal("logfmt").default("logfmt"),
    file_path: z.string().min(1).default(getDefaultLogPath()),
    webhook_archive_dir: z.string().optional(),
  }),
  database: z.object({
    path: z.string().min(1).default(getDefaultDatabasePath()),
    wal: z.boolean().default(true),
  }),
  linear: z.object({
    webhook_secret_env: z.string().default("LINEAR_WEBHOOK_SECRET"),
    graphql_url: z.string().url().default("https://api.linear.app/graphql"),
    token_encryption_key_env: z.string().default("PATCHRELAY_TOKEN_ENCRYPTION_KEY"),
    oauth: z.object({
      client_id_env: z.string().default("LINEAR_OAUTH_CLIENT_ID"),
      client_secret_env: z.string().default("LINEAR_OAUTH_CLIENT_SECRET"),
      redirect_uri: z.string().url().optional(),
      scopes: z.array(z.string().min(1)).default(["read", "write", "app:assignable", "app:mentionable"]),
      actor: z.enum(["user", "app"]).default("app"),
    }),
  }),
  operator_api: z
    .object({
      enabled: z.boolean().default(false),
      bearer_token_env: z.string().optional(),
    })
    .default({
      enabled: false,
    }),
  runner: z.object({
    git_bin: z.string().default("git"),
    codex: z.object({
      bin: z.string().default("codex"),
      args: z.array(z.string()).default(["app-server"]),
      shell_bin: z.string().optional(),
      source_bashrc: z.boolean().default(true),
      model: z.string().optional(),
      model_provider: z.string().optional(),
      service_name: z.string().default("patchrelay"),
      base_instructions: z.string().optional(),
      developer_instructions: z.string().optional(),
      approval_policy: z.enum(["never", "on-request", "on-failure", "untrusted"]).default("never"),
      sandbox_mode: z.enum(["danger-full-access", "workspace-write", "read-only"]).default("danger-full-access"),
      persist_extended_history: z.boolean().default(false),
    }),
  }),
  projects: z.array(projectSchema).default([]),
});

function defaultTriggerEvents(actor: "user" | "app"): AppConfig["projects"][number]["triggerEvents"] {
  if (actor === "app") {
    return ["agentSessionCreated", "agentPrompted", "statusChanged"];
  }

  return ["statusChanged"];
}

const builtinWorkflows: z.infer<typeof workflowSchema>[] = [
  {
    id: "development",
    when_state: "Start",
    active_state: "Implementing",
    workflow_file: "IMPLEMENTATION_WORKFLOW.md",
    fallback_state: "Human Needed",
  },
  {
    id: "review",
    when_state: "Review",
    active_state: "Reviewing",
    workflow_file: "REVIEW_WORKFLOW.md",
    fallback_state: "Human Needed",
  },
  {
    id: "deploy",
    when_state: "Deploy",
    active_state: "Deploying",
    workflow_file: "DEPLOY_WORKFLOW.md",
    fallback_state: "Human Needed",
  },
  {
    id: "cleanup",
    when_state: "Cleanup",
    active_state: "Cleaning Up",
    workflow_file: "CLEANUP_WORKFLOW.md",
    fallback_state: "Human Needed",
  },
];

function withSectionDefaults(input: unknown): unknown {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const { linear: _linear, runner: _runner, ...rest } = source;
  const linear = source.linear && typeof source.linear === "object" ? (source.linear as Record<string, unknown>) : {};
  const runner = source.runner && typeof source.runner === "object" ? (source.runner as Record<string, unknown>) : {};
  const linearOauth = linear.oauth && typeof linear.oauth === "object" ? (linear.oauth as Record<string, unknown>) : {};
  const runnerCodex = runner.codex && typeof runner.codex === "object" ? (runner.codex as Record<string, unknown>) : {};

  return {
    server: {},
    ingress: {},
    logging: {},
    database: {},
    operator_api: {},
    projects: [],
    ...rest,
    linear: {
      ...linear,
      oauth: linearOauth,
    },
    runner: {
      ...runner,
      codex: runnerCodex,
    },
  };
}

function expandEnv(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-(.*?))?\}/g, (_match, name: string, fallback?: string) => {
      return env[name] ?? fallback ?? "";
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => expandEnv(entry, env));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandEnv(entry, env)]));
  }

  return value;
}

function readEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) {
    return {};
  }

  const values: Record<string, string> = {};
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const name = trimmed.slice(0, separator).trim();
    if (!name) {
      continue;
    }

    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }

  return values;
}

export function getAdjacentEnvFilePaths(
  configPath = process.env.PATCHRELAY_CONFIG ?? getDefaultConfigPath(),
): {
  runtimeEnvPath: string;
  serviceEnvPath: string;
} {
  const resolvedPath = ensureAbsolutePath(configPath);
  const configDir = path.dirname(resolvedPath);
  return {
    runtimeEnvPath:
      configDir === path.dirname(getDefaultConfigPath()) ? getDefaultRuntimeEnvPath() : path.join(configDir, "runtime.env"),
    serviceEnvPath:
      configDir === path.dirname(getDefaultConfigPath()) ? getDefaultServiceEnvPath() : path.join(configDir, "service.env"),
  };
}

function getEnvFilesForProfile(
  configPath: string,
  profile: ConfigLoadProfile,
): string[] {
  const { runtimeEnvPath, serviceEnvPath } = getAdjacentEnvFilePaths(configPath);

  switch (profile) {
    case "service":
      return [runtimeEnvPath, serviceEnvPath];
    case "cli":
    case "write_config":
      return [runtimeEnvPath];
    case "operator_cli":
      return [runtimeEnvPath, serviceEnvPath];
    case "doctor":
      return [runtimeEnvPath, serviceEnvPath];
  }
}

function readEnvFilesForProfile(configPath: string, profile: ConfigLoadProfile): Record<string, string> {
  const paths = getEnvFilesForProfile(configPath, profile);
  return Object.assign({}, ...paths.map((envPath) => readEnvFile(envPath)));
}

function resolveWorkflowFilePath(repoPath: string, workflowFile: string): string {
  return path.isAbsolute(workflowFile) ? ensureAbsolutePath(workflowFile) : path.resolve(repoPath, workflowFile);
}

function defaultWorktreeRoot(projectId: string): string {
  return path.join(getPatchRelayDataDir(), "worktrees", projectId);
}

function defaultBranchPrefix(projectId: string): string {
  const sanitized = projectId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "patchrelay";
}

function formatUrlHost(host: string): string {
  return isIP(host) === 6 && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeLocalRedirectHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::") {
    return "::1";
  }
  return host;
}

function deriveLinearOAuthRedirectUri(server: {
  bind: string;
  port: number;
  public_base_url?: string | undefined;
}): string {
  if (server.public_base_url) {
    return new URL(LINEAR_OAUTH_CALLBACK_PATH, new URL(server.public_base_url).origin).toString();
  }

  const host = normalizeLocalRedirectHost(server.bind);
  return new URL(LINEAR_OAUTH_CALLBACK_PATH, `http://${formatUrlHost(host)}:${server.port}`).toString();
}

function mergeWorkflows(
  repoPath: string,
  workflows: z.infer<typeof workflowSchema>[],
): AppConfig["projects"][number]["workflows"] {
  return workflows.map((workflow) => ({
    id: workflow.id,
    whenState: workflow.when_state,
    activeState: workflow.active_state,
    workflowFile: resolveWorkflowFilePath(repoPath, workflow.workflow_file),
    ...(workflow.fallback_state ? { fallbackState: workflow.fallback_state } : {}),
  }));
}

export function loadConfig(
  configPath = process.env.PATCHRELAY_CONFIG ?? getDefaultConfigPath(),
  options?: { profile?: ConfigLoadProfile },
): AppConfig {
  const requestedPath = ensureAbsolutePath(configPath);
  if (!existsSync(requestedPath)) {
    throw new Error(`Config file not found: ${requestedPath}. Run "patchrelay init" to create it.`);
  }

  const profile = options?.profile ?? "service";
  const adjacentEnv = readEnvFilesForProfile(requestedPath, profile);
  const env = {
    ...adjacentEnv,
    ...process.env,
  };

  const raw = readFileSync(requestedPath, "utf8");
  const parsedYaml = YAML.parse(raw);
  const parsed = configSchema.parse(withSectionDefaults(expandEnv(parsedYaml, env)));

  const requirements = getLoadProfileRequirements(profile);
  const webhookSecret = env[parsed.linear.webhook_secret_env];
  const tokenEncryptionKey = env[parsed.linear.token_encryption_key_env];
  const oauthClientId = env[parsed.linear.oauth.client_id_env];
  const oauthClientSecret = env[parsed.linear.oauth.client_secret_env];
  const operatorApiToken = parsed.operator_api.bearer_token_env
    ? env[parsed.operator_api.bearer_token_env]
    : undefined;
  if (requirements.requireWebhookSecret && !webhookSecret) {
    throw new Error(`Missing env var ${parsed.linear.webhook_secret_env}`);
  }
  if (requirements.requireOAuthClientId && !oauthClientId) {
    throw new Error(`Missing env var ${parsed.linear.oauth.client_id_env}`);
  }
  if (requirements.requireOAuthClientSecret && !oauthClientSecret) {
    throw new Error(`Missing env var ${parsed.linear.oauth.client_secret_env}`);
  }
  if (requirements.requireTokenEncryptionKey && !tokenEncryptionKey) {
    throw new Error(`Missing env var ${parsed.linear.token_encryption_key_env}`);
  }

  const logFilePath = env.PATCHRELAY_LOG_FILE ?? parsed.logging.file_path;
  const webhookArchiveDir = env.PATCHRELAY_WEBHOOK_ARCHIVE_DIR ?? parsed.logging.webhook_archive_dir;
  const oauthRedirectUri = parsed.linear.oauth.redirect_uri ?? deriveLinearOAuthRedirectUri(parsed.server);

  const config: AppConfig = {
    server: {
      bind: parsed.server.bind,
      port: parsed.server.port,
      ...(parsed.server.public_base_url ? { publicBaseUrl: parsed.server.public_base_url } : {}),
      healthPath: parsed.server.health_path,
      readinessPath: parsed.server.readiness_path,
    },
    ingress: {
      linearWebhookPath: parsed.ingress.linear_webhook_path,
      maxBodyBytes: parsed.ingress.max_body_bytes,
      maxTimestampSkewSeconds: parsed.ingress.max_timestamp_skew_seconds,
    },
    logging: {
      level: (env.PATCHRELAY_LOG_LEVEL as AppConfig["logging"]["level"] | undefined) ?? parsed.logging.level,
      format: parsed.logging.format,
      filePath: ensureAbsolutePath(logFilePath),
      ...(webhookArchiveDir ? { webhookArchiveDir: ensureAbsolutePath(webhookArchiveDir) } : {}),
    },
    database: {
      path: ensureAbsolutePath(env.PATCHRELAY_DB_PATH ?? parsed.database.path),
      wal: parsed.database.wal,
    },
    linear: {
      webhookSecret: webhookSecret ?? "",
      graphqlUrl: parsed.linear.graphql_url,
      oauth: {
        clientId: oauthClientId ?? "",
        clientSecret: oauthClientSecret ?? "",
        redirectUri: oauthRedirectUri,
        scopes: parsed.linear.oauth.scopes,
        actor: parsed.linear.oauth.actor,
      },
      tokenEncryptionKey: tokenEncryptionKey ?? "",
    },
    operatorApi: {
      enabled: parsed.operator_api.enabled,
      ...(operatorApiToken ? { bearerToken: operatorApiToken } : {}),
    },
    runner: {
      gitBin: parsed.runner.git_bin,
      codex: {
        bin: parsed.runner.codex.bin,
        args: parsed.runner.codex.args,
        ...(parsed.runner.codex.shell_bin ? { shellBin: parsed.runner.codex.shell_bin } : {}),
        sourceBashrc: parsed.runner.codex.source_bashrc,
        ...(parsed.runner.codex.model ? { model: parsed.runner.codex.model } : {}),
        ...(parsed.runner.codex.model_provider ? { modelProvider: parsed.runner.codex.model_provider } : {}),
        ...(parsed.runner.codex.service_name ? { serviceName: parsed.runner.codex.service_name } : {}),
        ...(parsed.runner.codex.base_instructions ? { baseInstructions: parsed.runner.codex.base_instructions } : {}),
        ...(parsed.runner.codex.developer_instructions
          ? { developerInstructions: parsed.runner.codex.developer_instructions }
          : {}),
        approvalPolicy: parsed.runner.codex.approval_policy,
        sandboxMode: parsed.runner.codex.sandbox_mode,
        persistExtendedHistory: parsed.runner.codex.persist_extended_history,
      },
    },
    projects: parsed.projects.map((project) => {
      const repoPath = ensureAbsolutePath(project.repo_path);
      return {
        id: project.id,
        repoPath,
        worktreeRoot: ensureAbsolutePath(project.worktree_root ?? defaultWorktreeRoot(project.id)),
        workflows: mergeWorkflows(repoPath, project.workflows ?? builtinWorkflows),
        ...(project.workflow_labels
          ? {
              workflowLabels: {
                ...(project.workflow_labels.working ? { working: project.workflow_labels.working } : {}),
                ...(project.workflow_labels.awaiting_handoff ? { awaitingHandoff: project.workflow_labels.awaiting_handoff } : {}),
              },
            }
          : {}),
        ...(project.trusted_actors
          ? {
              trustedActors: {
                ids: project.trusted_actors.ids,
                names: project.trusted_actors.names,
                emails: project.trusted_actors.emails,
                emailDomains: project.trusted_actors.email_domains,
              },
            }
          : {}),
        issueKeyPrefixes: project.issue_key_prefixes,
        linearTeamIds: project.linear_team_ids,
        allowLabels: project.allow_labels,
        triggerEvents:
          (project.trigger_events as AppConfig["projects"][number]["triggerEvents"] | undefined) ??
          defaultTriggerEvents(parsed.linear.oauth.actor),
        branchPrefix: project.branch_prefix ?? defaultBranchPrefix(project.id),
      };
    }),
  };

  validateConfigSemantics(config, {
    allowMissingOperatorApiToken: requirements.allowMissingOperatorApiToken,
  });
  return config;
}

export type ConfigLoadProfile = "service" | "cli" | "operator_cli" | "doctor" | "write_config";

function getLoadProfileRequirements(profile: ConfigLoadProfile): {
  requireWebhookSecret: boolean;
  requireOAuthClientId: boolean;
  requireOAuthClientSecret: boolean;
  requireTokenEncryptionKey: boolean;
  allowMissingOperatorApiToken: boolean;
} {
  switch (profile) {
    case "service":
      return {
        requireWebhookSecret: true,
        requireOAuthClientId: true,
        requireOAuthClientSecret: true,
        requireTokenEncryptionKey: true,
        allowMissingOperatorApiToken: false,
      };
    case "operator_cli":
      return {
        requireWebhookSecret: false,
        requireOAuthClientId: false,
        requireOAuthClientSecret: false,
        requireTokenEncryptionKey: false,
        allowMissingOperatorApiToken: false,
      };
    case "cli":
    case "doctor":
    case "write_config":
      return {
        requireWebhookSecret: false,
        requireOAuthClientId: false,
        requireOAuthClientSecret: false,
        requireTokenEncryptionKey: false,
        allowMissingOperatorApiToken: true,
      };
  }
}

function validateConfigSemantics(
  config: AppConfig,
  options?: { allowMissingOperatorApiToken?: boolean },
): void {
  const redirectUri = new URL(config.linear.oauth.redirectUri);
  if (redirectUri.pathname !== LINEAR_OAUTH_CALLBACK_PATH) {
    throw new Error(`linear.oauth.redirect_uri must use the fixed "${LINEAR_OAUTH_CALLBACK_PATH}" path`);
  }

  const projectIds = new Set<string>();
  const issuePrefixes = new Map<string, string>();
  const linearTeamIds = new Map<string, string>();

  for (const project of config.projects) {
    if (projectIds.has(project.id)) {
      throw new Error(`Duplicate project id: ${project.id}`);
    }
    projectIds.add(project.id);

    for (const prefix of project.issueKeyPrefixes) {
      const owner = issuePrefixes.get(prefix);
      if (owner && owner !== project.id) {
        throw new Error(`Issue key prefix "${prefix}" is configured for both ${owner} and ${project.id}`);
      }
      issuePrefixes.set(prefix, project.id);
    }

    for (const teamId of project.linearTeamIds) {
      const owner = linearTeamIds.get(teamId);
      if (owner && owner !== project.id) {
        throw new Error(`Linear team id "${teamId}" is configured for both ${owner} and ${project.id}`);
      }
      linearTeamIds.set(teamId, project.id);
    }

    const workflowIds = new Set<string>();
    const workflowStates = new Set<string>();
    for (const workflow of project.workflows) {
      const normalizedWorkflowId = workflow.id.trim().toLowerCase();
      if (workflowIds.has(normalizedWorkflowId)) {
        throw new Error(`Workflow id "${workflow.id}" is configured more than once in project ${project.id}`);
      }
      workflowIds.add(normalizedWorkflowId);

      const normalizedState = workflow.whenState.trim().toLowerCase();
      if (workflowStates.has(normalizedState)) {
        throw new Error(`Linear state "${workflow.whenState}" is configured for more than one workflow in project ${project.id}`);
      }
      workflowStates.add(normalizedState);
    }
  }

  if (
    config.operatorApi.enabled &&
    config.server.bind !== "127.0.0.1" &&
    !config.operatorApi.bearerToken &&
    !options?.allowMissingOperatorApiToken
  ) {
    throw new Error("operator_api.enabled requires operator_api.bearer_token_env when server.bind is not 127.0.0.1");
  }
}
