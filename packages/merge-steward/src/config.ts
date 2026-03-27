import { z } from "zod";
import { readFileSync } from "node:fs";

export const stewardConfigSchema = z.object({
  repoId: z.string().min(1),
  repoFullName: z.string().min(1),
  baseBranch: z.string().default("main"),
  worktreeRoot: z.string().min(1),
  gitBin: z.string().default("git"),
  maxRepairAttempts: z.number().int().min(0).default(3),
  flakyRetries: z.number().int().min(0).default(1),
  requiredChecks: z.array(z.string()).default([]),
  pollIntervalMs: z.number().int().min(1000).default(30_000),
  server: z.object({
    bind: z.string().default("127.0.0.1"),
    port: z.number().int().default(8790),
  }).default({ bind: "127.0.0.1", port: 8790 }),
  database: z.object({
    path: z.string().min(1),
    wal: z.boolean().default(true),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({ level: "info" }),
  patchrelayApiUrl: z.string().url().optional(),
});

export type StewardConfig = z.infer<typeof stewardConfigSchema>;

export function loadConfig(path?: string): StewardConfig {
  const configPath = path ?? process.env["MERGE_STEWARD_CONFIG"];
  if (!configPath) {
    throw new Error("Config path required: set MERGE_STEWARD_CONFIG or pass --config");
  }
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return stewardConfigSchema.parse(parsed);
}
