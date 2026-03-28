import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { resolveSecret } from "./resolve-secret.ts";
import { getDefaultRuntimeEnvPath, getDefaultServiceEnvPath } from "./runtime-paths.ts";

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
  speculativeDepth: z.number().int().min(1).default(3),
  requiredChecks: z.array(z.string()).default([]),
  pollIntervalMs: z.number().int().min(1000).default(30_000),
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
  mergeMethod: z.enum(["merge", "squash"]).default("merge"),
  admissionLabel: z.string().default("queue"),
  /** Branch name patterns to exclude from admission (glob-style). */
  excludeBranches: z.array(z.string()).default(["release-please--*"]),
  webhookPath: z.string().default("/webhooks/github/queue"),
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
