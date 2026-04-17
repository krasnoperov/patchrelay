import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_DIFF_IGNORE,
  DEFAULT_DIFF_SUMMARIZE_ONLY,
  DEFAULT_PATCH_BODY_BUDGET_TOKENS,
} from "./diff-context/defaults.ts";
import { getDefaultRuntimeEnvPath, getDefaultServiceEnvPath } from "./runtime-paths.ts";
import { resolveSecretWithSource } from "./resolve-secret.ts";
import type { ReviewQuillConfig } from "./types.ts";

const repositorySchema = z.object({
  repoId: z.string().min(1),
  repoFullName: z.string().min(1),
  baseBranch: z.string().default("main"),
  waitForGreenChecks: z.boolean().default(false),
  requiredChecks: z.array(z.string()).default([]),
  excludeBranches: z.array(z.string()).default([]),
  reviewDocs: z.array(z.string()).default(["REVIEW_WORKFLOW.md", "CLAUDE.md", "AGENTS.md"]),
  diffIgnore: z.array(z.string()).default([...DEFAULT_DIFF_IGNORE]),
  diffSummarizeOnly: z.array(z.string()).default([...DEFAULT_DIFF_SUMMARIZE_ONLY]),
  patchBodyBudgetTokens: z.number().int().min(1_000).default(DEFAULT_PATCH_BODY_BUDGET_TOKENS),
});

const promptLayerSchema = z.object({
  extra_instructions_file: z.string().min(1).optional(),
  replace_sections: z.record(z.string().min(1), z.string().min(1)).default({}),
});

const configSchema = z.object({
  server: z.object({
    bind: z.string().default("127.0.0.1"),
    port: z.number().int().default(8788),
    publicBaseUrl: z.string().url().optional(),
  }).default({ bind: "127.0.0.1", port: 8788 }),
  database: z.object({
    path: z.string().min(1),
    wal: z.boolean().default(true),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({ level: "info" }),
  reconciliation: z.object({
    pollIntervalMs: z.number().int().min(5_000).default(120_000),
    heartbeatIntervalMs: z.number().int().min(5_000).default(30_000),
    staleQueuedAfterMs: z.number().int().min(30_000).default(5 * 60_000),
    staleRunningAfterMs: z.number().int().min(60_000).default(20 * 60_000),
  }).default({
    pollIntervalMs: 120_000,
    heartbeatIntervalMs: 30_000,
    staleQueuedAfterMs: 5 * 60_000,
    staleRunningAfterMs: 20 * 60_000,
  }),
  codex: z.object({
    bin: z.string().default("codex"),
    args: z.array(z.string()).default(["app-server"]),
    shellBin: z.string().optional(),
    sourceBashrc: z.boolean().default(true),
    requestTimeoutMs: z.number().int().min(1_000).default(30_000),
    model: z.string().optional(),
    modelProvider: z.string().optional(),
    serviceName: z.string().default("review-quill"),
    approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]).default("never"),
    // Match patchrelay's default. The Codex sandbox uses bwrap, which
    // tries to set up a fresh network namespace per exec call when
    // run under read-only / workspace-write modes. Inside many host
    // configurations (kernel `unprivileged_userns_clone=1` but no
    // CAP_NET_ADMIN propagation, e.g. systemd-managed services with
    // PrivateNetwork=false but reduced caps) that fails with
    // `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`
    // and the agent cannot run any bash command — including the
    // `git diff` and `cat`/`sed` calls it needs to read context
    // around findings.
    //
    // `danger-full-access` skips bwrap entirely and runs the agent's
    // tool calls in the parent environment. We're OK with this for
    // review-quill because: (a) the agent never commits or pushes
    // (review-quill posts the review via GitHub App, not git); (b)
    // the worktree is a throwaway temp directory cleaned up after
    // the run; (c) the alternative is a non-functional reviewer.
    sandboxMode: z.enum(["danger-full-access", "workspace-write", "read-only"]).default("danger-full-access"),
  }).default({
    bin: "codex",
    args: ["app-server"],
    sourceBashrc: true,
    requestTimeoutMs: 30_000,
    serviceName: "review-quill",
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
  }),
  prompting: promptLayerSchema.default({
    replace_sections: {},
  }),
  repositories: z.array(repositorySchema).default([]),
});
type PromptLayerConfig = z.infer<typeof promptLayerSchema>;

function readPromptFile(configDir: string, filePath: string): NonNullable<ReviewQuillConfig["prompting"]["extraInstructions"]> {
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
): ReviewQuillConfig["prompting"] {
  return {
    ...(layer.extra_instructions_file
      ? { extraInstructions: readPromptFile(configDir, layer.extra_instructions_file) }
      : {}),
    replaceSections: Object.fromEntries(
      Object.entries(layer.replace_sections).map(([sectionId, fragmentPath]) => [sectionId, readPromptFile(configDir, fragmentPath)]),
    ),
  };
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};

  const values: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
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
  return [path.join(configDir, "runtime.env"), path.join(configDir, "service.env")];
}

export function loadConfig(configPath: string): ReviewQuillConfig {
  const raw = readFileSync(configPath, "utf8");
  const adjacentEnv = Object.assign({}, ...getAdjacentEnvFiles(configPath).map((filePath) => readEnvFile(filePath)));
  const env = { ...adjacentEnv, ...process.env } as Record<string, string | undefined>;
  const parsed = configSchema.parse(JSON.parse(raw) as unknown);
  const configDir = path.dirname(configPath);
  const webhookSecret = resolveSecretWithSource("review-quill-webhook-secret", "REVIEW_QUILL_WEBHOOK_SECRET", env);
  const publicBaseUrl = parsed.server.publicBaseUrl ?? env.REVIEW_QUILL_PUBLIC_BASE_URL;
  const server = {
    bind: parsed.server.bind,
    port: parsed.server.port,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
  };
  const codex = {
    bin: parsed.codex.bin,
    args: parsed.codex.args,
    ...(parsed.codex.shellBin ? { shellBin: parsed.codex.shellBin } : {}),
    ...(parsed.codex.sourceBashrc !== undefined ? { sourceBashrc: parsed.codex.sourceBashrc } : {}),
    ...(parsed.codex.requestTimeoutMs !== undefined ? { requestTimeoutMs: parsed.codex.requestTimeoutMs } : {}),
    ...(parsed.codex.model ? { model: parsed.codex.model } : {}),
    ...(parsed.codex.modelProvider ? { modelProvider: parsed.codex.modelProvider } : {}),
    ...(parsed.codex.serviceName ? { serviceName: parsed.codex.serviceName } : {}),
    approvalPolicy: parsed.codex.approvalPolicy,
    sandboxMode: parsed.codex.sandboxMode,
  };

  return {
    ...parsed,
    server,
    codex,
    prompting: loadPromptLayer(configDir, parsed.prompting),
    secretSources: {
      "review-quill-webhook-secret": webhookSecret.source,
    },
  };
}
