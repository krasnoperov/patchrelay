import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { getReviewQuillPathLayout } from "./runtime-paths.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export function defaultRunCommand(command: string, args: string[]): Promise<CommandResult> {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  return Promise.resolve({
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
}

export function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = statSync(filePath).isFile() ? readFileSync(filePath, "utf8") : "";
  const values: Record<string, string> = {};
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
    if (name) values[name] = value;
  }
  return values;
}

export function getHomeEnv(): Record<string, string | undefined> {
  const layout = getReviewQuillPathLayout();
  return {
    ...readEnvFile(layout.runtimeEnvPath),
    ...readEnvFile(layout.serviceEnvPath),
    ...process.env,
  };
}

export function checkPath(targetPath: string, writable = false): { ok: boolean; message: string } {
  if (!existsSync(targetPath)) {
    return { ok: false, message: `Missing path: ${targetPath}` };
  }
  try {
    const stats = statSync(targetPath);
    if (!stats.isDirectory() && !stats.isFile()) {
      return { ok: false, message: `Unexpected path type: ${targetPath}` };
    }
    if (writable) {
      accessSync(stats.isDirectory() ? targetPath : path.dirname(targetPath), constants.W_OK);
    }
    return { ok: true, message: writable ? `${targetPath} is writable` : `${targetPath} exists` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function checkExecutable(command: string): { ok: boolean; message: string } {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (result.status === 0) {
    return { ok: true, message: `${command} is available` };
  }
  return { ok: false, message: `${command} is not available in PATH` };
}

export function listRepoConfigs(): Array<{
  repoId: string;
  repoFullName: string;
  baseBranch: string;
  requiredChecks: string[];
  excludeBranches: string[];
  reviewDocs: string[];
}> {
  const layout = getReviewQuillPathLayout();
  if (!existsSync(layout.configPath)) {
    return [];
  }
  const config = loadConfig(layout.configPath);
  return [...config.repositories].sort((left, right) => left.repoId.localeCompare(right.repoId));
}

export function loadRepoConfigById(repoRef: string): {
  configPath: string;
  repo: {
    repoId: string;
    repoFullName: string;
    baseBranch: string;
    requiredChecks: string[];
    excludeBranches: string[];
    reviewDocs: string[];
  };
  publicBaseUrl?: string;
} {
  const layout = getReviewQuillPathLayout();
  if (!existsSync(layout.configPath)) {
    throw new Error(`review-quill home is not initialized. Run \`review-quill init <public-base-url>\` first so ${layout.configPath} exists.`);
  }
  const config = loadConfig(layout.configPath);
  const repo = config.repositories.find((entry) => entry.repoId === repoRef || entry.repoFullName === repoRef);
  if (!repo) {
    const configured = config.repositories.map((entry) => entry.repoId).join(", ");
    throw new Error(
      `Repo config not found for ${repoRef}. Run \`review-quill attach <owner/repo>\` first.${configured ? ` Configured repos: ${configured}.` : ""}`,
    );
  }
  return {
    configPath: layout.configPath,
    repo,
    ...(config.server.publicBaseUrl ? { publicBaseUrl: config.server.publicBaseUrl } : {}),
  };
}

export function buildWebhookUrl(): string | undefined {
  const layout = getReviewQuillPathLayout();
  if (!existsSync(layout.configPath)) {
    return undefined;
  }
  const config = loadConfig(layout.configPath);
  return config.server.publicBaseUrl ? `${config.server.publicBaseUrl.replace(/\/$/, "")}/webhooks/github` : undefined;
}

export function parseSystemctlShowOutput(raw: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    properties[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return properties;
}

export function formatCommandFailure(result: CommandResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

export async function runSystemctl(runCommand: CommandRunner, args: string[]): Promise<{ ok: true; result: CommandResult } | { ok: false; error: string; result: CommandResult }> {
  const result = await runCommand("sudo", ["systemctl", ...args]);
  if (result.exitCode === 0) {
    return { ok: true, result };
  }
  return {
    ok: false,
    error: formatCommandFailure(result, `sudo systemctl ${args.join(" ")} exited with status ${result.exitCode}`),
    result,
  };
}

function getLocalBaseUrl(): string {
  const layout = getReviewQuillPathLayout();
  const config = loadConfig(layout.configPath);
  return `http://${config.server.bind}:${config.server.port}`;
}

async function requestLocalJson<T>(relativePath: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`${getLocalBaseUrl()}${relativePath}`, {
    method: options?.method ?? "GET",
    ...(options?.body !== undefined ? { headers: { "content-type": "application/json" } } : {}),
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(2_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status} from ${relativePath}`);
  }
  return JSON.parse(text) as T;
}

export async function fetchServiceHealth(): Promise<{ ok: boolean; service: string; repos: string[] }> {
  return await requestLocalJson<{ ok: boolean; service: string; repos: string[] }>("/health");
}

export async function fetchServiceAuthStatus(): Promise<{
  mode: string;
  ready: boolean;
  appId?: string;
  installationMode?: string;
  appSlug?: string;
  webhookSecretSource?: string;
}> {
  return await requestLocalJson("/admin/runtime/auth");
}

export async function fetchWatchSnapshot(): Promise<{
  summary: {
    totalRepos: number;
    totalAttempts: number;
    queuedAttempts: number;
    runningAttempts: number;
    completedAttempts: number;
    failedAttempts: number;
  };
}> {
  return await requestLocalJson("/watch");
}

export async function triggerServiceReconcile(repoFullName?: string): Promise<{ ok: boolean; started: boolean }> {
  return await requestLocalJson("/admin/reconcile", {
    method: "POST",
    ...(repoFullName ? { body: { repoFullName } } : {}),
  });
}
