import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppConfig } from "./types.js";
import { ensureAbsolutePath } from "./utils.js";

const projectSchema = z.object({
  id: z.string().min(1),
  repo_path: z.string().min(1),
  worktree_root: z.string().min(1),
  workflow_files: z.object({
    development: z.string().min(1),
    review: z.string().min(1),
    deploy: z.string().min(1),
    cleanup: z.string().min(1),
  }),
  workflow_statuses: z.object({
    development: z.string().min(1).default("Start"),
    review: z.string().min(1).default("Review"),
    deploy: z.string().min(1).default("Deploy"),
    development_active: z.string().min(1).default("Implementing"),
    review_active: z.string().min(1).default("Reviewing"),
    deploy_active: z.string().min(1).default("Deploying"),
    cleanup: z.string().optional(),
    cleanup_active: z.string().optional(),
    human_needed: z.string().optional(),
    done: z.string().optional(),
  }),
  workflow_labels: z
    .object({
      working: z.string().min(1).optional(),
      awaiting_handoff: z.string().min(1).optional(),
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
  }),
  ingress: z.object({
    linear_webhook_path: z.string().default("/webhooks/linear"),
    max_body_bytes: z.number().int().positive().default(262144),
    max_timestamp_skew_seconds: z.number().int().positive().default(60),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    format: z.literal("logfmt").default("logfmt"),
    file_path: z.string().min(1).default("/var/log/patchrelay/patchrelay.log"),
    webhook_archive_dir: z.string().optional(),
  }),
  database: z.object({
    path: z.string().min(1),
    wal: z.boolean().default(true),
  }),
  linear: z.object({
    webhook_secret_env: z.string().default("LINEAR_WEBHOOK_SECRET"),
    api_token_env: z.string().default("LINEAR_API_TOKEN"),
    graphql_url: z.string().url().default("https://api.linear.app/graphql"),
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
  projects: z.array(projectSchema).min(1),
});

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

export function loadConfig(
  configPath = process.env.PATCHRELAY_CONFIG ?? path.resolve("config/patchrelay.yaml"),
  options?: { requireLinearSecret?: boolean },
): AppConfig {
  const requestedPath = ensureAbsolutePath(configPath);
  const fallbackPath = ensureAbsolutePath(path.resolve("config/patchrelay.example.yaml"));
  const resolvedPath = existsSync(requestedPath) ? requestedPath : fallbackPath;
  if (!existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${requestedPath}`);
  }

  const raw = readFileSync(resolvedPath, "utf8");
  const parsedYaml = YAML.parse(raw);
  const parsed = configSchema.parse(expandEnv(parsedYaml));

  const requireLinearSecret = options?.requireLinearSecret ?? true;
  const webhookSecret = process.env[parsed.linear.webhook_secret_env];
  const apiToken = process.env[parsed.linear.api_token_env];
  if (requireLinearSecret && !webhookSecret) {
    throw new Error(`Missing env var ${parsed.linear.webhook_secret_env}`);
  }

  const logFilePath = process.env.PATCHRELAY_LOG_FILE ?? parsed.logging.file_path;
  const webhookArchiveDir = process.env.PATCHRELAY_WEBHOOK_ARCHIVE_DIR ?? parsed.logging.webhook_archive_dir;

  return {
    server: {
      bind: parsed.server.bind,
      port: parsed.server.port,
      healthPath: parsed.server.health_path,
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
      ...(apiToken ? { apiToken } : {}),
      graphqlUrl: parsed.linear.graphql_url,
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
      workflowFiles: {
        development: ensureAbsolutePath(project.workflow_files.development),
        review: ensureAbsolutePath(project.workflow_files.review),
        deploy: ensureAbsolutePath(project.workflow_files.deploy),
        cleanup: ensureAbsolutePath(project.workflow_files.cleanup),
      },
      workflowStatuses: {
        development: project.workflow_statuses.development,
        review: project.workflow_statuses.review,
        deploy: project.workflow_statuses.deploy,
        developmentActive: project.workflow_statuses.development_active,
        reviewActive: project.workflow_statuses.review_active,
        deployActive: project.workflow_statuses.deploy_active,
        ...(project.workflow_statuses.cleanup ? { cleanup: project.workflow_statuses.cleanup } : {}),
        ...(project.workflow_statuses.cleanup_active ? { cleanupActive: project.workflow_statuses.cleanup_active } : {}),
        ...(project.workflow_statuses.human_needed ? { humanNeeded: project.workflow_statuses.human_needed } : {}),
        ...(project.workflow_statuses.done ? { done: project.workflow_statuses.done } : {}),
      },
      ...(project.workflow_labels
        ? {
            workflowLabels: {
              ...(project.workflow_labels.working ? { working: project.workflow_labels.working } : {}),
              ...(project.workflow_labels.awaiting_handoff ? { awaitingHandoff: project.workflow_labels.awaiting_handoff } : {}),
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
}
