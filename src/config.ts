import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
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
import { resolveSecretWithSource } from "./resolve-secret.ts";
import { ensureAbsolutePath } from "./utils.ts";

const LINEAR_OAUTH_CALLBACK_PATH = "/oauth/linear/callback";
const REPO_SETTINGS_DIRNAME = ".patchrelay";
const REPO_SETTINGS_FILENAME = "project.json";
const DEFAULT_PATCHRELAY_DEVELOPER_INSTRUCTIONS = [
  "You are PatchRelay's coding agent.",
  "",
  "Core rules:",
  "- Complete the delegated task in the current repository and worktree.",
  "- Stay inside the issue's scope. Do not widen into unrelated cleanup or polish.",
  "- Use repository docs and workflow files as the source of truth for local conventions.",
  "- Prefer concrete fixes over speculative defenses.",
  "- For code-delivery work, publish before stopping.",
  "- If you change files for an implementation run, commit, push the issue branch, and open or update the PR.",
  "- For repair runs, work on the existing PR branch and do not open a new PR.",
  "- A requested-changes repair is only complete after a newer PR head is pushed, unless a genuine external blocker prevents correct publication.",
  "- If you change schema, enums, shared vocabulary, normalization helpers, or compatibility mappings, inspect the main read/write paths that can bypass the new abstraction and fix or cover any mismatch before publishing.",
  "- For CI repair, do not change code or config until you either reproduce the failure on the exact failing head or can point to a concrete log signature that justifies the fix. If you cannot reproduce it, prefer a rerun-only repair over speculative changes.",
  "- If a broader inconsistency is not required to make this task correct, mention it briefly instead of expanding scope.",
  "- Before publishing, do one brief reviewer-minded pass on the current head and fix likely in-scope blockers.",
].join("\n");

const trustedActorsSchema = z
  .object({
    ids: z.array(z.string().min(1)).default([]),
    names: z.array(z.string().min(1)).default([]),
    emails: z.array(z.string().email()).default([]),
    email_domains: z.array(z.string().min(1)).default([]),
  })
  .optional();

const repoSettingsSchema = z.object({
  trigger_events: z.array(z.string().min(1)).min(1).optional(),
  branch_prefix: z.string().min(1).optional(),
});

const repairBudgetsSchema = z.object({
  ci_repair: z.number().int().positive().default(10),
  queue_repair: z.number().int().positive().default(10),
  review_fix: z.number().int().positive().default(10),
});

const projectSchema = z.object({
  id: z.string().min(1),
  repo_path: z.string().min(1),
  worktree_root: z.string().min(1).optional(),
  trusted_actors: trustedActorsSchema,
  issue_key_prefixes: z.array(z.string().min(1)).default([]),
  linear_team_ids: z.array(z.string().min(1)).default([]),
  allow_labels: z.array(z.string().min(1)).default([]),
  trigger_events: z.array(z.string().min(1)).min(1).optional(),
  branch_prefix: z.string().min(1).optional(),
  repair_budgets: repairBudgetsSchema.default({
    ci_repair: 10,
    queue_repair: 10,
    review_fix: 10,
  }),
  /** Check names that are review gates (AI Review, quality analysis). Default: code class. */
  review_checks: z.array(z.string().min(1)).default([]),
  /** Check names that are policy gates (conventional title, release policy). Default: code class. */
  gate_checks: z.array(z.string().min(1)).default([]),
  github: z.object({
    webhook_secret: z.string().min(1).optional(),
    repo_full_name: z.string().min(1).optional(),
    base_branch: z.string().min(1).optional(),
  }).optional(),
});

const repositorySchema = z.object({
  github_repo: z.string().min(1),
  local_path: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  linear_team_ids: z.array(z.string().min(1)).default([]),
  linear_project_ids: z.array(z.string().min(1)).default([]),
  issue_key_prefixes: z.array(z.string().min(1)).default([]),
  review_checks: z.array(z.string().min(1)).default([]),
  gate_checks: z.array(z.string().min(1)).default([]),
  trigger_events: z.array(z.string().min(1)).min(1).optional(),
  branch_prefix: z.string().min(1).optional(),
  repair_budgets: repairBudgetsSchema.default({
    ci_repair: 10,
    queue_repair: 10,
    review_fix: 10,
  }),
  github: z.object({
    webhook_secret: z.string().min(1).optional(),
    base_branch: z.string().min(1).optional(),
    merge_queue_label: z.string().min(1).optional(),
    merge_queue_check_name: z.string().min(1).optional(),
  }).optional(),
});

const promptLayerSchema = z.object({
  extra_instructions_file: z.string().min(1).optional(),
  replace_sections: z.record(z.string().min(1), z.string().min(1)).default({}),
});

const promptByRunTypeSchema = z.object({
  implementation: promptLayerSchema.optional(),
  review_fix: promptLayerSchema.optional(),
  branch_upkeep: promptLayerSchema.optional(),
  ci_repair: promptLayerSchema.optional(),
  queue_repair: promptLayerSchema.optional(),
});
type PromptLayerConfig = z.infer<typeof promptLayerSchema>;

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
    github_webhook_path: z.string().default("/webhooks/github"),
    max_body_bytes: z.number().int().positive().default(262144),
    max_timestamp_skew_seconds: z.number().int().positive().default(60),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    format: z.literal("logfmt").default("logfmt"),
    file_path: z.string().min(1).default(getDefaultLogPath()),
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
      request_timeout_ms: z.number().int().positive().default(30000),
      model: z.string().optional(),
      model_provider: z.string().optional(),
      reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
      service_name: z.string().default("patchrelay"),
      base_instructions: z.string().optional(),
      developer_instructions: z.string().optional(),
      approval_policy: z.enum(["never", "on-request", "on-failure", "untrusted"]).default("never"),
      sandbox_mode: z.enum(["danger-full-access", "workspace-write", "read-only"]).default("danger-full-access"),
      persist_extended_history: z.boolean().default(false),
      experimental_raw_events: z.boolean().default(true),
    }),
  }),
  prompting: z.object({
    default: promptLayerSchema.default({
      replace_sections: {},
    }),
    by_run_type: promptByRunTypeSchema.default({}),
  }).default({
    default: {
      replace_sections: {},
    },
    by_run_type: {},
  }),
  repos: z.object({
    root: z.string().min(1).default(path.join(homedir(), "projects")),
  }).default(() => ({ root: path.join(homedir(), "projects") })),
  projects: z.array(projectSchema).default([]),
  repositories: z.array(repositorySchema).default([]),
});

function defaultTriggerEvents(actor: "user" | "app"): AppConfig["projects"][number]["triggerEvents"] {
  if (actor === "app") {
    return ["delegateChanged", "statusChanged", "agentSessionCreated", "agentPrompted", "commentCreated", "commentUpdated"];
  }

  return ["statusChanged"];
}

function normalizeTriggerEvents(
  actor: "user" | "app",
  configured: AppConfig["projects"][number]["triggerEvents"] | undefined,
): AppConfig["projects"][number]["triggerEvents"] {
  if (actor !== "app") {
    return configured ?? defaultTriggerEvents(actor);
  }

  const required = defaultTriggerEvents(actor);
  if (!configured || configured.length === 0) {
    return required;
  }

  const seen = new Set(required);
  const extras = configured.filter((event) => {
    if (seen.has(event)) {
      return false;
    }
    seen.add(event);
    return true;
  });
  return [...required, ...extras];
}

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
    prompting: {},
    repos: {},
    projects: [],
    repositories: [],
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

function resolveRepoSettingsPath(repoPath: string): string {
  return path.join(repoPath, REPO_SETTINGS_DIRNAME, REPO_SETTINGS_FILENAME);
}

function readPromptFile(configDir: string, filePath: string): NonNullable<AppConfig["prompting"]["default"]["extraInstructions"]> {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Prompt file not found: ${resolvedPath}`);
  }
  return {
    sourcePath: resolvedPath,
    content: readFileSync(resolvedPath, "utf8").trim(),
  };
}

function loadPromptLayer(
  configDir: string,
  layer: PromptLayerConfig,
): AppConfig["prompting"]["default"] {
  return {
    ...(layer.extra_instructions_file
      ? { extraInstructions: readPromptFile(configDir, layer.extra_instructions_file) }
      : {}),
    replaceSections: Object.fromEntries(
      Object.entries(layer.replace_sections).map(([sectionId, fragmentPath]) => [sectionId, readPromptFile(configDir, fragmentPath)]),
    ),
  };
}

function mergeDeveloperInstructions(custom: string | undefined): string {
  const normalized = custom?.trim();
  if (!normalized) {
    return DEFAULT_PATCHRELAY_DEVELOPER_INSTRUCTIONS;
  }
  return `${DEFAULT_PATCHRELAY_DEVELOPER_INSTRUCTIONS}\n\n## Local Developer Instructions\n\n${normalized}`;
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

function parseJsonFile(filePath: string, label: string): unknown {
  const raw = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON ${label}: ${filePath}: ${message}`, {
      cause: error,
    });
  }
}

function readRepoSettings(
  repoPath: string,
  env: Record<string, string | undefined>,
): (z.infer<typeof repoSettingsSchema> & { configPath: string }) | undefined {
  const configPath = resolveRepoSettingsPath(repoPath);
  if (!existsSync(configPath)) {
    return undefined;
  }

  const parsed = repoSettingsSchema.parse(expandEnv(parseJsonFile(configPath, "repo settings file"), env));
  return {
    ...parsed,
    configPath,
  };
}

function defaultWorktreeRoot(projectId: string): string {
  return path.join(getPatchRelayDataDir(), "worktrees", projectId);
}

function defaultRepositoryLocalPath(reposRoot: string, githubRepo: string): string {
  const repoName = githubRepo.split("/").pop()?.trim();
  if (!repoName) {
    throw new Error(`Invalid github_repo: ${githubRepo}`);
  }
  return path.join(ensureAbsolutePath(reposRoot), repoName);
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

  const parsedFile = parseJsonFile(requestedPath, "config file");
  const parsed = configSchema.parse(withSectionDefaults(expandEnv(parsedFile, env)));
  const configDir = path.dirname(requestedPath);

  const requirements = getLoadProfileRequirements(profile);
  const rWebhookSecret = resolveSecretWithSource("linear-webhook-secret", parsed.linear.webhook_secret_env, env);
  const rTokenEncryptionKey = resolveSecretWithSource("token-encryption-key", parsed.linear.token_encryption_key_env, env);
  const rOAuthClientId = resolveSecretWithSource("linear-oauth-client-id", parsed.linear.oauth.client_id_env, env);
  const rOAuthClientSecret = resolveSecretWithSource("linear-oauth-client-secret", parsed.linear.oauth.client_secret_env, env);
  const rOperatorApiToken = parsed.operator_api.bearer_token_env
    ? resolveSecretWithSource("operator-api-token", parsed.operator_api.bearer_token_env, env)
    : undefined;
  const webhookSecret = rWebhookSecret.value;
  const tokenEncryptionKey = rTokenEncryptionKey.value;
  const oauthClientId = rOAuthClientId.value;
  const oauthClientSecret = rOAuthClientSecret.value;
  const operatorApiToken = rOperatorApiToken?.value;
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
  const oauthRedirectUri = parsed.linear.oauth.redirect_uri ?? deriveLinearOAuthRedirectUri(parsed.server);
  const reposRoot = ensureAbsolutePath(parsed.repos.root);

  const repositories = parsed.repositories.map((repository) => {
    const localPath = ensureAbsolutePath(repository.local_path ?? defaultRepositoryLocalPath(reposRoot, repository.github_repo));
    return {
      githubRepo: repository.github_repo,
      localPath,
      ...(repository.workspace ? { workspace: repository.workspace } : {}),
      linearTeamIds: repository.linear_team_ids,
      linearProjectIds: repository.linear_project_ids,
      issueKeyPrefixes: repository.issue_key_prefixes,
      reviewChecks: repository.review_checks,
      gateChecks: repository.gate_checks,
      triggerEvents: repository.trigger_events as AppConfig["projects"][number]["triggerEvents"] | undefined,
      branchPrefix: repository.branch_prefix,
      repairBudgets: {
        ciRepair: repository.repair_budgets.ci_repair,
        queueRepair: repository.repair_budgets.queue_repair,
        reviewFix: repository.repair_budgets.review_fix,
      },
      github: repository.github,
    };
  });

  const repositoryProjects = repositories.map((repository) => {
    const repoSettings = readRepoSettings(repository.localPath, env);
    return {
      id: repository.githubRepo,
      repoPath: repository.localPath,
      worktreeRoot: ensureAbsolutePath(defaultWorktreeRoot(repository.githubRepo)),
      issueKeyPrefixes: repository.issueKeyPrefixes,
      linearTeamIds: repository.linearTeamIds,
      allowLabels: [],
      reviewChecks: repository.reviewChecks,
      gateChecks: repository.gateChecks,
      triggerEvents: normalizeTriggerEvents(
        parsed.linear.oauth.actor,
        (repoSettings?.trigger_events as AppConfig["projects"][number]["triggerEvents"] | undefined) ?? repository.triggerEvents,
      ),
      branchPrefix: repoSettings?.branch_prefix ?? repository.branchPrefix ?? defaultBranchPrefix(repository.githubRepo),
      repairBudgets: repository.repairBudgets,
      ...(repoSettings?.configPath ? { repoSettingsPath: repoSettings.configPath } : {}),
      github: {
        repoFullName: repository.githubRepo,
        ...(repository.github?.base_branch ? { baseBranch: repository.github.base_branch } : {}),
        ...(repository.github?.webhook_secret ? { webhookSecret: repository.github.webhook_secret } : {}),
        ...(repository.github?.merge_queue_label ? { mergeQueueLabel: repository.github.merge_queue_label } : {}),
        ...(repository.github?.merge_queue_check_name ? { mergeQueueCheckName: repository.github.merge_queue_check_name } : {}),
      },
    };
  });

  const legacyProjects = parsed.projects.map((project) => {
        const repoPath = ensureAbsolutePath(project.repo_path);
        const repoSettings = readRepoSettings(repoPath, env);
        const trustedActors = project.trusted_actors;
        return {
          id: project.id,
          repoPath,
          worktreeRoot: ensureAbsolutePath(project.worktree_root ?? defaultWorktreeRoot(project.id)),
          ...(trustedActors
            ? {
                trustedActors: {
                  ids: trustedActors.ids,
                  names: trustedActors.names,
                  emails: trustedActors.emails,
                  emailDomains: trustedActors.email_domains,
                },
              }
            : {}),
          issueKeyPrefixes: project.issue_key_prefixes,
          linearTeamIds: project.linear_team_ids,
          allowLabels: project.allow_labels,
          reviewChecks: project.review_checks,
          gateChecks: project.gate_checks,
          triggerEvents: normalizeTriggerEvents(
            parsed.linear.oauth.actor,
            (repoSettings?.trigger_events as AppConfig["projects"][number]["triggerEvents"] | undefined) ??
              (project.trigger_events as AppConfig["projects"][number]["triggerEvents"] | undefined),
          ),
          branchPrefix: repoSettings?.branch_prefix ?? project.branch_prefix ?? defaultBranchPrefix(project.id),
          repairBudgets: {
            ciRepair: project.repair_budgets.ci_repair,
            queueRepair: project.repair_budgets.queue_repair,
            reviewFix: project.repair_budgets.review_fix,
          },
          ...(repoSettings?.configPath ? { repoSettingsPath: repoSettings.configPath } : {}),
          ...(project.github ? {
            github: {
              ...(project.github.webhook_secret ? { webhookSecret: project.github.webhook_secret } : {}),
              ...(project.github.repo_full_name ? { repoFullName: project.github.repo_full_name } : {}),
              ...(project.github.base_branch ? { baseBranch: project.github.base_branch } : {}),
            },
          } : {}),
        };
      });
  const repositoryPaths = new Set(repositoryProjects.map((project) => project.repoPath));
  const derivedProjects = [...repositoryProjects, ...legacyProjects.filter((project) => !repositoryPaths.has(project.repoPath))];

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
      githubWebhookPath: parsed.ingress.github_webhook_path,
      maxBodyBytes: parsed.ingress.max_body_bytes,
      maxTimestampSkewSeconds: parsed.ingress.max_timestamp_skew_seconds,
    },
    logging: {
      level: (env.PATCHRELAY_LOG_LEVEL as AppConfig["logging"]["level"] | undefined) ?? parsed.logging.level,
      format: parsed.logging.format,
      filePath: ensureAbsolutePath(logFilePath),
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
        requestTimeoutMs: parsed.runner.codex.request_timeout_ms,
        ...(parsed.runner.codex.model ? { model: parsed.runner.codex.model } : {}),
        ...(parsed.runner.codex.model_provider ? { modelProvider: parsed.runner.codex.model_provider } : {}),
        ...(parsed.runner.codex.reasoning_effort ? { reasoningEffort: parsed.runner.codex.reasoning_effort } : {}),
        ...(parsed.runner.codex.service_name ? { serviceName: parsed.runner.codex.service_name } : {}),
        ...(parsed.runner.codex.base_instructions ? { baseInstructions: parsed.runner.codex.base_instructions } : {}),
        developerInstructions: mergeDeveloperInstructions(parsed.runner.codex.developer_instructions),
        approvalPolicy: parsed.runner.codex.approval_policy,
        sandboxMode: parsed.runner.codex.sandbox_mode,
        persistExtendedHistory: parsed.runner.codex.persist_extended_history,
        experimentalRawEvents: parsed.runner.codex.experimental_raw_events,
      },
    },
    prompting: {
      default: loadPromptLayer(configDir, parsed.prompting.default),
      byRunType: Object.fromEntries(
        Object.entries(parsed.prompting.by_run_type)
          .filter(([, layer]) => Boolean(layer))
          .map(([runType, layer]) => [runType, loadPromptLayer(configDir, layer!)]),
      ) as AppConfig["prompting"]["byRunType"],
    },
    repos: {
      root: reposRoot,
    },
    repositories: repositories.map((repository) => ({
      githubRepo: repository.githubRepo,
      localPath: repository.localPath,
      ...(repository.workspace ? { workspace: repository.workspace } : {}),
      linearTeamIds: repository.linearTeamIds,
      linearProjectIds: repository.linearProjectIds,
      issueKeyPrefixes: repository.issueKeyPrefixes,
    })),
    projects: derivedProjects,
    secretSources: {
      "linear-webhook-secret": rWebhookSecret.source,
      "token-encryption-key": rTokenEncryptionKey.source,
      "linear-oauth-client-id": rOAuthClientId.source,
      "linear-oauth-client-secret": rOAuthClientSecret.source,
      ...(rOperatorApiToken ? { "operator-api-token": rOperatorApiToken.source } : {}),
    },
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
  const githubRepos = new Set<string>();
  const issuePrefixes = new Map<string, string>();
  const linearTeamIds = new Map<string, string>();

  for (const repository of config.repositories) {
    if (githubRepos.has(repository.githubRepo)) {
      throw new Error(`Duplicate repository github_repo: ${repository.githubRepo}`);
    }
    githubRepos.add(repository.githubRepo);
  }

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

  if (
    config.operatorApi.enabled &&
    config.server.bind !== "127.0.0.1" &&
    !config.operatorApi.bearerToken &&
    !options?.allowMissingOperatorApiToken
  ) {
    throw new Error("operator_api.enabled requires operator_api.bearer_token_env when server.bind is not 127.0.0.1");
  }
}
