import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getReviewQuillPathLayout, readBundledAsset } from "./runtime-paths.ts";
import type { ReviewQuillRepositoryConfig } from "./types.ts";

function renderTemplate(template: string, replacements?: { publicBaseUrl?: string }): string {
  const home = homedir();
  const user = basename(home);
  const layout = getReviewQuillPathLayout();
  let rendered = template
    .replaceAll("/home/your-user", home)
    .replaceAll("your-user", user);

  if (replacements?.publicBaseUrl) {
    rendered = rendered.replaceAll("https://patchrelay.example.com/review", replacements.publicBaseUrl);
  }

  return rendered;
}

async function writeTemplateFile(
  targetPath: string,
  content: string,
  force: boolean,
  options?: { mode?: number },
): Promise<"created" | "skipped"> {
  if (!force && existsSync(targetPath)) {
    return "skipped";
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, options?.mode === undefined ? "utf8" : { encoding: "utf8", mode: options.mode });
  return "created";
}

function defaultConfigDocument(publicBaseUrl: string, databasePath: string): Record<string, unknown> {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8788,
      publicBaseUrl,
    },
    database: {
      path: databasePath,
      wal: true,
    },
    logging: {
      level: "info",
    },
    reconciliation: {
      pollIntervalMs: 120000,
    },
    codex: {
      bin: "codex",
      args: ["app-server"],
      sourceBashrc: true,
      requestTimeoutMs: 30000,
      serviceName: "review-quill",
      approvalPolicy: "never",
      sandboxMode: "read-only",
    },
    repositories: [],
  };
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function applyPublicBaseUrlToConfig(configPath: string, publicBaseUrl: string, databasePath: string): Promise<"created" | "updated" | "skipped"> {
  const raw = existsSync(configPath) ? await readFile(configPath, "utf8") : undefined;
  const current = raw ? JSON.parse(raw) as Record<string, unknown> : defaultConfigDocument(publicBaseUrl, databasePath);
  const next = {
    ...current,
    server: {
      bind: "127.0.0.1",
      port: 8788,
      ...(typeof current.server === "object" && current.server ? current.server as Record<string, unknown> : {}),
      publicBaseUrl,
    },
    database: {
      path: databasePath,
      wal: true,
      ...(typeof current.database === "object" && current.database ? current.database as Record<string, unknown> : {}),
    },
    repositories: Array.isArray(current.repositories) ? current.repositories : [],
  };
  const rendered = stringifyJson(next);
  if (!raw) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, rendered, "utf8");
    return "created";
  }
  if (raw === rendered) {
    return "skipped";
  }
  await writeFile(configPath, rendered, "utf8");
  return "updated";
}

function normalizeRepoId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Repo id is required.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) {
    throw new Error("Repo id may contain only letters, numbers, dots, underscores, and hyphens.");
  }
  return trimmed;
}

function parseRepoFullName(value: string): string {
  const trimmed = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new Error(`GitHub repo must use owner/repo form. Received: ${value}`);
  }
  return trimmed;
}

export async function initializeReviewQuillHome(options: { publicBaseUrl: string; force?: boolean }): Promise<{
  configDir: string;
  runtimeEnvPath: string;
  serviceEnvPath: string;
  configPath: string;
  stateDir: string;
  dataDir: string;
  runtimeEnvStatus: "created" | "skipped";
  serviceEnvStatus: "created" | "skipped";
  configStatus: "created" | "updated" | "skipped";
}> {
  const force = options.force ?? false;
  const layout = getReviewQuillPathLayout();
  await mkdir(layout.configDir, { recursive: true });
  await mkdir(layout.stateDir, { recursive: true });
  await mkdir(layout.dataDir, { recursive: true });

  const runtimeEnvStatus = await writeTemplateFile(
    layout.runtimeEnvPath,
    renderTemplate(readBundledAsset("runtime.env.example"), { publicBaseUrl: options.publicBaseUrl }),
    force,
  );
  const serviceEnvStatus = await writeTemplateFile(
    layout.serviceEnvPath,
    renderTemplate(readBundledAsset("service.env.example")),
    force,
    { mode: 0o600 },
  );
  const configStatus = await applyPublicBaseUrlToConfig(
    layout.configPath,
    options.publicBaseUrl,
    `${layout.stateDir}/review-quill.sqlite`,
  );

  return {
    configDir: layout.configDir,
    runtimeEnvPath: layout.runtimeEnvPath,
    serviceEnvPath: layout.serviceEnvPath,
    configPath: layout.configPath,
    stateDir: layout.stateDir,
    dataDir: layout.dataDir,
    runtimeEnvStatus,
    serviceEnvStatus,
    configStatus,
  };
}

export async function installServiceUnit(options?: { force?: boolean }): Promise<{
  unitPath: string;
  runtimeEnvPath: string;
  serviceEnvPath: string;
  configPath: string;
  status: "created" | "skipped";
}> {
  const force = options?.force ?? false;
  const layout = getReviewQuillPathLayout();
  const status = await writeTemplateFile(
    layout.systemdUnitPath,
    renderTemplate(readBundledAsset("infra/review-quill.service")),
    force,
  );
  return {
    unitPath: layout.systemdUnitPath,
    runtimeEnvPath: layout.runtimeEnvPath,
    serviceEnvPath: layout.serviceEnvPath,
    configPath: layout.configPath,
    status,
  };
}

export async function upsertRepoConfig(options: {
  id: string;
  repoFullName: string;
  baseBranch?: string;
  requiredChecks?: string[];
  excludeBranches?: string[];
  reviewDocs?: string[];
  diffIgnore?: string[];
  diffSummarizeOnly?: string[];
  maxPatchLines?: number;
  maxPatchBytes?: number;
  maxFilesWithFullPatch?: number;
}): Promise<{
  configPath: string;
  status: "created" | "updated" | "unchanged";
  repo: ReviewQuillRepositoryConfig;
}> {
  const layout = getReviewQuillPathLayout();
  if (!existsSync(layout.configPath)) {
    throw new Error(
      `review-quill home is not initialized. Run \`review-quill init <public-base-url>\` first so ${layout.configPath} exists.`,
    );
  }

  const raw = await readFile(layout.configPath, "utf8");
  const document = JSON.parse(raw) as Record<string, unknown>;
  const repositories = Array.isArray(document.repositories) ? document.repositories as Array<Record<string, unknown>> : [];
  const repoId = normalizeRepoId(options.id);
  const repoFullName = parseRepoFullName(options.repoFullName);
  const existingIndex = repositories.findIndex((entry) => entry.repoId === repoId || entry.repoFullName === repoFullName);
  const existing = existingIndex >= 0 ? repositories[existingIndex]! : undefined;

  const repo: ReviewQuillRepositoryConfig = {
    repoId,
    repoFullName,
    baseBranch: options.baseBranch?.trim() || (typeof existing?.baseBranch === "string" ? existing.baseBranch : "main"),
    requiredChecks: [...new Set((options.requiredChecks ?? (Array.isArray(existing?.requiredChecks) ? existing.requiredChecks as string[] : [])).map((entry) => entry.trim()).filter(Boolean))],
    excludeBranches: [...new Set((options.excludeBranches ?? (Array.isArray(existing?.excludeBranches) ? existing.excludeBranches as string[] : ["release-please--*"])).map((entry) => entry.trim()).filter(Boolean))],
    reviewDocs: [...new Set((options.reviewDocs ?? (Array.isArray(existing?.reviewDocs) ? existing.reviewDocs as string[] : ["REVIEW_WORKFLOW.md", "CLAUDE.md", "AGENTS.md"])).map((entry) => entry.trim()).filter(Boolean))],
    diffIgnore: [...new Set((options.diffIgnore ?? (Array.isArray(existing?.diffIgnore) ? existing.diffIgnore as string[] : [])).map((entry) => entry.trim()).filter(Boolean))],
    diffSummarizeOnly: [...new Set((options.diffSummarizeOnly ?? (Array.isArray(existing?.diffSummarizeOnly) ? existing.diffSummarizeOnly as string[] : [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock*",
      "dist/**",
      "build/**",
      "coverage/**",
      "*.map",
      "*.min.js",
      "*.snap",
    ])).map((entry) => entry.trim()).filter(Boolean))],
    maxPatchLines: options.maxPatchLines ?? (typeof existing?.maxPatchLines === "number" ? existing.maxPatchLines : 400),
    maxPatchBytes: options.maxPatchBytes ?? (typeof existing?.maxPatchBytes === "number" ? existing.maxPatchBytes : 24_000),
    maxFilesWithFullPatch: options.maxFilesWithFullPatch ?? (typeof existing?.maxFilesWithFullPatch === "number" ? existing.maxFilesWithFullPatch : 20),
  };

  const nextRepositories: Array<Record<string, unknown>> = repositories.filter((entry) => entry.repoId !== repoId && entry.repoFullName !== repoFullName);
  nextRepositories.push({
    repoId: repo.repoId,
    repoFullName: repo.repoFullName,
    baseBranch: repo.baseBranch,
    requiredChecks: repo.requiredChecks,
    excludeBranches: repo.excludeBranches,
    reviewDocs: repo.reviewDocs,
    diffIgnore: repo.diffIgnore,
    diffSummarizeOnly: repo.diffSummarizeOnly,
    maxPatchLines: repo.maxPatchLines,
    maxPatchBytes: repo.maxPatchBytes,
    maxFilesWithFullPatch: repo.maxFilesWithFullPatch,
  });
  nextRepositories.sort((left, right) => String(left.repoId ?? "").localeCompare(String(right.repoId ?? "")));

  const nextDocument = {
    ...document,
    repositories: nextRepositories,
  };
  const rendered = stringifyJson(nextDocument);
  const status: "created" | "updated" | "unchanged" =
    !existing ? "created" : rendered === raw ? "unchanged" : "updated";

  if (status !== "unchanged") {
    await writeFile(layout.configPath, rendered, "utf8");
  }

  return {
    configPath: layout.configPath,
    status,
    repo,
  };
}
