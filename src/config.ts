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
    implementation: z.string().min(1),
    review: z.string().min(1),
    deploy: z.string().min(1),
  }),
  workflow_statuses: z.object({
    implementation: z.string().min(1).default("Start"),
    review: z.string().min(1).default("Review"),
    deploy: z.string().min(1).default("Deploy"),
    human_needed: z.string().optional(),
  }),
  linear_team_ids: z.array(z.string().min(1)).default([]),
  allow_labels: z.array(z.string().min(1)).default([]),
  trigger_events: z.array(z.string().min(1)).min(1),
  branch_prefix: z.string().min(1),
});

const configSchema = z.object({
  server: z.object({
    bind: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(8787),
    health_path: z.string().default("/healthz"),
  }),
  ingress: z.object({
    linear_webhook_path: z.string().default("/webhooks/linear"),
    max_body_bytes: z.number().int().positive().default(262144),
    max_timestamp_skew_seconds: z.number().int().positive().default(60),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    format: z.literal("json").default("json"),
    file_path: z.string().min(1).default("/var/log/patchrelay/patchrelay.log"),
    webhook_archive_dir: z.string().optional(),
  }),
  database: z.object({
    path: z.string().min(1),
    wal: z.boolean().default(true),
  }),
  linear: z.object({
    webhook_secret_env: z.string().default("LINEAR_WEBHOOK_SECRET"),
  }),
  runner: z
    .object({
      zmx_bin: z.string().default("zmx"),
      git_bin: z.string().default("git"),
      launch: z.object({
        shell: z.string().default("codex"),
        args: z.array(z.string()).min(1),
      }),
    })
    .default({
      zmx_bin: "zmx",
      git_bin: "git",
      launch: {
        shell: "codex",
        args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--cd", "{worktreePath}", "{prompt}"],
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

export function loadConfig(configPath = process.env.PATCHRELAY_CONFIG ?? path.resolve("config/patchrelay.yaml")): AppConfig {
  const requestedPath = ensureAbsolutePath(configPath);
  const fallbackPath = ensureAbsolutePath(path.resolve("config/patchrelay.example.yaml"));
  const resolvedPath = existsSync(requestedPath) ? requestedPath : fallbackPath;
  if (!existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${requestedPath}`);
  }

  const raw = readFileSync(resolvedPath, "utf8");
  const parsedYaml = YAML.parse(raw);
  const parsed = configSchema.parse(expandEnv(parsedYaml));

  const webhookSecret = process.env[parsed.linear.webhook_secret_env];
  const logFilePath = process.env.PATCHRELAY_LOG_FILE ?? parsed.logging.file_path;
  const webhookArchiveDir = process.env.PATCHRELAY_WEBHOOK_ARCHIVE_DIR ?? parsed.logging.webhook_archive_dir;

  if (!webhookSecret) {
    throw new Error(`Missing env var ${parsed.linear.webhook_secret_env}`);
  }

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
      webhookSecret,
    },
    runner: {
      zmxBin: parsed.runner.zmx_bin,
      gitBin: parsed.runner.git_bin,
      launch: parsed.runner.launch,
    },
    projects: parsed.projects.map((project) => ({
      id: project.id,
      repoPath: ensureAbsolutePath(project.repo_path),
      worktreeRoot: ensureAbsolutePath(project.worktree_root),
      workflowFiles: {
        implementation: ensureAbsolutePath(project.workflow_files.implementation),
        review: ensureAbsolutePath(project.workflow_files.review),
        deploy: ensureAbsolutePath(project.workflow_files.deploy),
      },
      workflowStatuses: {
        implementation: project.workflow_statuses.implementation,
        review: project.workflow_statuses.review,
        deploy: project.workflow_statuses.deploy,
        ...(project.workflow_statuses.human_needed ? { humanNeeded: project.workflow_statuses.human_needed } : {}),
      },
      linearTeamIds: project.linear_team_ids,
      allowLabels: project.allow_labels,
      triggerEvents: project.trigger_events as AppConfig["projects"][number]["triggerEvents"],
      branchPrefix: project.branch_prefix,
    })),
  };
}
