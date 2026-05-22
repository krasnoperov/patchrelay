import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { resolveSecret } from "./resolve-secret.ts";
import { getDefaultRuntimeEnvPath, getDefaultServiceEnvPath } from "./runtime-paths.ts";

export const DEFAULT_MERGE_QUEUE_CHECK_NAME = "merge-steward/queue";

export const stewardConfigSchema = z.object({
  repoId: z.string().min(1),
  repoFullName: z.string().min(1),
  baseBranch: z.string().default("main"),
  /** Path to the steward's local clone of the repository. */
  clonePath: z.string().min(1),
  gitBin: z.string().default("git"),
  maxRetries: z.number().int().min(0).default(2),
  flakyRetries: z.number().int().min(0).default(1),
  /** Max speculative branches to maintain in parallel. 1 = serial mode. */
  speculativeDepth: z.number().int().min(1).default(10),
  pollIntervalMs: z.number().int().min(1000).default(30_000),
  reconcileStaleAfterMs: z.number().int().min(1000).default(5 * 60_000),
  server: z.object({
    bind: z.string().default("127.0.0.1"),
    port: z.number().int().default(8790),
    publicBaseUrl: z.string().url().optional(),
  }).default({ bind: "127.0.0.1", port: 8790 }),
  database: z.object({
    path: z.string().min(1),
    wal: z.boolean().default(true),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({ level: "info" }),
  admissionLabel: z.string().default("queue"),
  priorityQueueLabel: z.string().default("queue:priority"),
  mergeQueueCheckName: z.string().default(DEFAULT_MERGE_QUEUE_CHECK_NAME),
  // Plan §2.4 — bus-contract artifact names exposed for cross-service
  // alignment. Defaults preserve current behavior. The steward writes
  // `evictionCheckName` (today: same as mergeQueueCheckName, kept for
  // contract clarity) and `specReadyCheckName`; consumers read them.
  /** Eviction check run name. Synonym for mergeQueueCheckName, surfaced
   * under the bus-contract name so consumer code can be naming-aligned
   * with patchrelay's resolver. */
  evictionCheckName: z.string().default(DEFAULT_MERGE_QUEUE_CHECK_NAME),
  /** Spec-ready check run name (default: "merge-steward/spec-ready").
   * Read by review-quill in integration_tree mode (plan §3.5). */
  specReadyCheckName: z.string().default("merge-steward/spec-ready"),
  /** Prefix for spec branch names (default: "mq-spec-"); matches the
   * existing SPEC_BRANCH_PREFIX in reconciler-core.ts. The pattern
   * review-quill matches against is `${prefix}*`. */
  specBranchPrefix: z.string().default("mq-spec-"),
  /** Branch name patterns to exclude from admission (glob-style). */
  excludeBranches: z.array(z.string()).default([]),
  /**
   * File patterns with regen commands for auto-resolving merge conflicts.
   * When all conflicting files match a pattern, the command is run to regenerate them.
   * Defaults to lockfile resolution for npm/pnpm/yarn.
   */
  autoResolvePatterns: z.array(z.object({
    glob: z.string().min(1),
    command: z.array(z.string()).min(1),
  })).default([
    { glob: "**/package-lock.json", command: ["npm", "install", "--package-lock-only"] },
    { glob: "**/pnpm-lock.yaml", command: ["pnpm", "install", "--lockfile-only"] },
    { glob: "**/yarn.lock", command: ["yarn", "install", "--mode", "update-lockfile"] },
  ]),
  webhookSecret: z.string().optional(),
});

export type StewardConfig = z.infer<typeof stewardConfigSchema>;

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const values: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (name) {
      values[name] = value;
    }
  }
  return values;
}

function getAdjacentEnvFiles(configPath: string): string[] {
  const configDir = path.dirname(configPath);
  const defaultRuntime = getDefaultRuntimeEnvPath();
  const defaultService = getDefaultServiceEnvPath();
  if (configDir === path.dirname(defaultRuntime)) {
    return [defaultRuntime, defaultService];
  }
  return [path.join(configDir, "..", "runtime.env"), path.join(configDir, "..", "service.env")];
}

export function parseConfig(raw: string, options?: { configPath?: string; env?: Record<string, string | undefined> }): StewardConfig {
  const parsed = JSON.parse(raw) as unknown;
  const env = options?.env ?? (process.env as Record<string, string | undefined>);
  const config = stewardConfigSchema.parse(parsed);
  const webhookSecret = config.webhookSecret ?? resolveSecret("merge-steward-webhook-secret", "MERGE_STEWARD_WEBHOOK_SECRET", env);
  const publicBaseUrl = config.server.publicBaseUrl ?? env.MERGE_STEWARD_PUBLIC_BASE_URL ?? undefined;
  return {
    ...config,
    server: {
      ...config.server,
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
    },
    ...(webhookSecret ? { webhookSecret } : {}),
  };
}

export function loadConfig(path?: string): StewardConfig {
  const configPath = path ?? process.env["MERGE_STEWARD_CONFIG"];
  if (!configPath) {
    throw new Error("Config path required: set MERGE_STEWARD_CONFIG or pass --config");
  }
  const raw = readFileSync(configPath, "utf8");
  const adjacentEnv = Object.assign(
    {},
    ...getAdjacentEnvFiles(configPath).map((filePath) => readEnvFile(filePath)),
  );
  return parseConfig(raw, {
    configPath,
    env: {
      ...adjacentEnv,
      ...process.env,
    },
  });
}
