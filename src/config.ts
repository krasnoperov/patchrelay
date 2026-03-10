import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppConfig } from "./types.ts";
import { getDefaultConfigPath, getDefaultDatabasePath, getDefaultLogPath } from "./runtime-paths.ts";
import { ensureAbsolutePath } from "./utils.ts";

const workflowFilesSchema = z.object({
  development: z.string().min(1),
  review: z.string().min(1),
  deploy: z.string().min(1),
  cleanup: z.string().min(1),
});

const workflowFilesOverrideSchema = workflowFilesSchema.partial();

const workflowStatusesSchema = z.object({
  development: z.string().min(1),
  review: z.string().min(1),
  deploy: z.string().min(1),
  development_active: z.string().min(1),
  review_active: z.string().min(1),
  deploy_active: z.string().min(1),
  cleanup: z.string().min(1).nullable().optional(),
  cleanup_active: z.string().min(1).nullable().optional(),
  human_needed: z.string().min(1).nullable().optional(),
  done: z.string().min(1).nullable().optional(),
});

const workflowStatusesOverrideSchema = workflowStatusesSchema.partial();

const projectSchema = z.object({
  id: z.string().min(1),
  repo_path: z.string().min(1),
  worktree_root: z.string().min(1),
  workflow_files: workflowFilesOverrideSchema.optional(),
  workflow_statuses: workflowStatusesOverrideSchema.optional(),
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
  trigger_events: z.array(z.string().min(1)).min(1),
  branch_prefix: z.string().min(1),
});

const configSchema = z.object({
  server: z.object({
    bind: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(8787),
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
      redirect_uri: z.string().url(),
      scopes: z.array(z.string().min(1)).default(["read", "write"]),
      actor: z.enum(["user", "app"]).default("user"),
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
  runner: z
    .object({
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
    })
    .default({
      git_bin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        source_bashrc: true,
        service_name: "patchrelay",
        approval_policy: "never",
        sandbox_mode: "danger-full-access",
        persist_extended_history: false,
      },
    }),
  defaults: z
    .object({
      workflow_files: workflowFilesOverrideSchema.optional(),
      workflow_statuses: workflowStatusesOverrideSchema.optional(),
    })
    .default({}),
  projects: z.array(projectSchema).min(1),
});

const builtinWorkflowFiles = {
  development: "IMPLEMENTATION_WORKFLOW.md",
  review: "REVIEW_WORKFLOW.md",
  deploy: "DEPLOY_WORKFLOW.md",
  cleanup: "CLEANUP_WORKFLOW.md",
} as const;

const builtinWorkflowStatuses = {
  development: "Start",
  review: "Review",
  deploy: "Deploy",
  development_active: "Implementing",
  review_active: "Reviewing",
  deploy_active: "Deploying",
  cleanup: "Cleanup",
  cleanup_active: "Cleaning Up",
  human_needed: "Human Needed",
  done: "Done",
} as const;

function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-(.*?))?\}/g, (_match, name: string, fallback?: string) => {
      return process.env[name] ?? fallback ?? "";
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => expandEnv(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandEnv(entry)]));
  }

  return value;
}

function resolveWorkflowFilePath(repoPath: string, workflowFile: string): string {
  return path.isAbsolute(workflowFile) ? ensureAbsolutePath(workflowFile) : path.resolve(repoPath, workflowFile);
}

function mergeWorkflowFiles(
  repoPath: string,
  defaults: z.infer<typeof workflowFilesOverrideSchema> | undefined,
  overrides: z.infer<typeof workflowFilesOverrideSchema> | undefined,
): AppConfig["projects"][number]["workflowFiles"] {
  const merged = {
    development: overrides?.development ?? defaults?.development ?? builtinWorkflowFiles.development,
    review: overrides?.review ?? defaults?.review ?? builtinWorkflowFiles.review,
    deploy: overrides?.deploy ?? defaults?.deploy ?? builtinWorkflowFiles.deploy,
    cleanup: overrides?.cleanup ?? defaults?.cleanup ?? builtinWorkflowFiles.cleanup,
  };

  return {
    development: resolveWorkflowFilePath(repoPath, merged.development),
    review: resolveWorkflowFilePath(repoPath, merged.review),
    deploy: resolveWorkflowFilePath(repoPath, merged.deploy),
    cleanup: resolveWorkflowFilePath(repoPath, merged.cleanup),
  };
}

function mergeWorkflowStatuses(
  defaults: z.infer<typeof workflowStatusesOverrideSchema> | undefined,
  overrides: z.infer<typeof workflowStatusesOverrideSchema> | undefined,
): AppConfig["projects"][number]["workflowStatuses"] {
  const merged = {
    development: overrides?.development ?? defaults?.development ?? builtinWorkflowStatuses.development,
    review: overrides?.review ?? defaults?.review ?? builtinWorkflowStatuses.review,
    deploy: overrides?.deploy ?? defaults?.deploy ?? builtinWorkflowStatuses.deploy,
    development_active:
      overrides?.development_active ?? defaults?.development_active ?? builtinWorkflowStatuses.development_active,
    review_active: overrides?.review_active ?? defaults?.review_active ?? builtinWorkflowStatuses.review_active,
    deploy_active: overrides?.deploy_active ?? defaults?.deploy_active ?? builtinWorkflowStatuses.deploy_active,
    cleanup:
      overrides?.cleanup !== undefined
        ? overrides.cleanup
        : defaults?.cleanup !== undefined
          ? defaults.cleanup
          : builtinWorkflowStatuses.cleanup,
    cleanup_active:
      overrides?.cleanup_active !== undefined
        ? overrides.cleanup_active
        : defaults?.cleanup_active !== undefined
          ? defaults.cleanup_active
          : builtinWorkflowStatuses.cleanup_active,
    human_needed:
      overrides?.human_needed !== undefined
        ? overrides.human_needed
        : defaults?.human_needed !== undefined
          ? defaults.human_needed
          : builtinWorkflowStatuses.human_needed,
    done:
      overrides?.done !== undefined
        ? overrides.done
        : defaults?.done !== undefined
          ? defaults.done
          : builtinWorkflowStatuses.done,
  };

  return {
    development: merged.development,
    review: merged.review,
    deploy: merged.deploy,
    developmentActive: merged.development_active,
    reviewActive: merged.review_active,
    deployActive: merged.deploy_active,
    ...(merged.cleanup ? { cleanup: merged.cleanup } : {}),
    ...(merged.cleanup && merged.cleanup_active ? { cleanupActive: merged.cleanup_active } : {}),
    ...(merged.human_needed ? { humanNeeded: merged.human_needed } : {}),
    ...(merged.done ? { done: merged.done } : {}),
  };
}

export function loadConfig(
  configPath = process.env.PATCHRELAY_CONFIG ?? getDefaultConfigPath(),
  options?: { requireLinearSecret?: boolean; allowMissingSecrets?: boolean },
): AppConfig {
  const requestedPath = ensureAbsolutePath(configPath);
  if (!existsSync(requestedPath)) {
    throw new Error(`Config file not found: ${requestedPath}. Run "patchrelay init" to create it.`);
  }

  const raw = readFileSync(requestedPath, "utf8");
  const parsedYaml = YAML.parse(raw);
  const parsed = configSchema.parse(expandEnv(parsedYaml));

  const requireLinearSecret = options?.requireLinearSecret ?? true;
  const allowMissingSecrets = options?.allowMissingSecrets ?? false;
  const webhookSecret = process.env[parsed.linear.webhook_secret_env];
  const tokenEncryptionKey = process.env[parsed.linear.token_encryption_key_env];
  const oauthClientId = process.env[parsed.linear.oauth.client_id_env];
  const oauthClientSecret = process.env[parsed.linear.oauth.client_secret_env];
  const operatorApiToken = parsed.operator_api.bearer_token_env
    ? process.env[parsed.operator_api.bearer_token_env]
    : undefined;
  if (requireLinearSecret && !webhookSecret && !allowMissingSecrets) {
    throw new Error(`Missing env var ${parsed.linear.webhook_secret_env}`);
  }
  if (!oauthClientId && !allowMissingSecrets) {
    throw new Error(`Missing env var ${parsed.linear.oauth.client_id_env}`);
  }
  if (!oauthClientSecret && !allowMissingSecrets) {
    throw new Error(`Missing env var ${parsed.linear.oauth.client_secret_env}`);
  }
  if (!tokenEncryptionKey && !allowMissingSecrets) {
    throw new Error(`Missing env var ${parsed.linear.token_encryption_key_env}`);
  }

  const logFilePath = process.env.PATCHRELAY_LOG_FILE ?? parsed.logging.file_path;
  const webhookArchiveDir = process.env.PATCHRELAY_WEBHOOK_ARCHIVE_DIR ?? parsed.logging.webhook_archive_dir;

  const config: AppConfig = {
    server: {
      bind: parsed.server.bind,
      port: parsed.server.port,
      healthPath: parsed.server.health_path,
      readinessPath: parsed.server.readiness_path,
    },
    ingress: {
      linearWebhookPath: parsed.ingress.linear_webhook_path,
      maxBodyBytes: parsed.ingress.max_body_bytes,
      maxTimestampSkewSeconds: parsed.ingress.max_timestamp_skew_seconds,
    },
    logging: {
      level: (process.env.PATCHRELAY_LOG_LEVEL as AppConfig["logging"]["level"] | undefined) ?? parsed.logging.level,
      format: parsed.logging.format,
      filePath: ensureAbsolutePath(logFilePath),
      ...(webhookArchiveDir ? { webhookArchiveDir: ensureAbsolutePath(webhookArchiveDir) } : {}),
    },
    database: {
      path: ensureAbsolutePath(process.env.PATCHRELAY_DB_PATH ?? parsed.database.path),
      wal: parsed.database.wal,
    },
    linear: {
      webhookSecret: webhookSecret ?? "",
      graphqlUrl: parsed.linear.graphql_url,
      oauth: {
        clientId: oauthClientId ?? "",
        clientSecret: oauthClientSecret ?? "",
        redirectUri: parsed.linear.oauth.redirect_uri,
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
    projects: parsed.projects.map((project) => ({
      id: project.id,
      repoPath: ensureAbsolutePath(project.repo_path),
      worktreeRoot: ensureAbsolutePath(project.worktree_root),
      workflowFiles: mergeWorkflowFiles(
        ensureAbsolutePath(project.repo_path),
        parsed.defaults.workflow_files,
        project.workflow_files,
      ),
      workflowStatuses: mergeWorkflowStatuses(parsed.defaults.workflow_statuses, project.workflow_statuses),
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
      triggerEvents: project.trigger_events as AppConfig["projects"][number]["triggerEvents"],
      branchPrefix: project.branch_prefix,
    })),
  };

  validateConfigSemantics(config);
  return config;
}

function validateConfigSemantics(config: AppConfig): void {
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
  }

  if (config.operatorApi.enabled && config.server.bind !== "127.0.0.1" && !config.operatorApi.bearerToken) {
    throw new Error("operator_api.enabled requires operator_api.bearer_token_env when server.bind is not 127.0.0.1");
  }
}
