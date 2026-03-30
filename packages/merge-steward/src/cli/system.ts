import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig, parseConfig, type StewardConfig } from "../config.ts";
import {
  getDefaultConfigPath,
  getDefaultRepoConfigDir,
  getDefaultRuntimeEnvPath,
  getDefaultServiceEnvPath,
  getRepoConfigPath,
} from "../runtime-paths.ts";
import { parseHomeConfigObject } from "../steward-home.ts";
import type { ParsedArgs, HelpTopic, CommandResult, CommandRunner } from "./types.ts";
import { UsageError } from "./types.ts";

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

export function getHomeEnv(): Record<string, string | undefined> {
  return {
    ...readEnvFile(getDefaultRuntimeEnvPath()),
    ...readEnvFile(getDefaultServiceEnvPath()),
    ...process.env,
  };
}

export function readHomeConfig(): { configPath: string; config: ReturnType<typeof parseHomeConfigObject> } {
  const configPath = getDefaultConfigPath();
  if (!existsSync(configPath)) {
    throw new UsageError(`merge-steward home is not initialized. Run \`merge-steward init <public-base-url>\` first so ${configPath} exists.`);
  }
  return {
    configPath,
    config: parseHomeConfigObject(readFileSync(configPath, "utf8"), configPath),
  };
}

export function listRepoConfigs(): Array<{
  repoId: string;
  repoFullName: string;
  baseBranch: string;
  requiredChecks: string[];
  admissionLabel: string;
  port: number;
  configPath: string;
}> {
  const repoConfigDir = getDefaultRepoConfigDir();
  if (!existsSync(repoConfigDir)) {
    return [];
  }
  return readdirSync(repoConfigDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const configPath = path.join(repoConfigDir, name);
      const config = parseConfig(readFileSync(configPath, "utf8"), { configPath });
      return {
        repoId: config.repoId,
        repoFullName: config.repoFullName,
        baseBranch: config.baseBranch,
        requiredChecks: config.requiredChecks,
        admissionLabel: config.admissionLabel,
        port: config.server.port,
        configPath,
      };
    });
}

export function loadRepoConfigById(repoId: string): { configPath: string; config: StewardConfig } {
  const configPath = getRepoConfigPath(repoId);
  if (!existsSync(configPath)) {
    throw new UsageError(`Repo config not found: ${configPath}. Run \`merge-steward attach ${repoId} <owner/repo>\` first.`, "repos");
  }
  return {
    configPath,
    config: loadConfig(configPath),
  };
}

export function buildWebhookUrl(config: StewardConfig): string | undefined {
  const homeConfigPath = getDefaultConfigPath();
  if (!existsSync(homeConfigPath)) {
    return undefined;
  }
  const homeConfig = parseHomeConfigObject(readFileSync(homeConfigPath, "utf8"), homeConfigPath);
  const publicBaseUrl = config.server.publicBaseUrl ?? homeConfig.server.public_base_url;
  return publicBaseUrl ? new URL(config.webhookPath, publicBaseUrl).toString() : undefined;
}

export function buildWebhookPattern(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/webhooks/github/queue/<repo-id>`;
}

export function resolveRepoId(parsed: ParsedArgs, positionalIndex = 2, helpTopic: HelpTopic = "root"): string {
  const positional = parsed.positionals[positionalIndex];
  if (positional) {
    return positional;
  }
  const flagged = parsed.flags.get("repo");
  if (typeof flagged === "string" && flagged.trim()) {
    return flagged.trim();
  }
  throw new UsageError("Repo id is required.", helpTopic);
}

export function resolveConfigPath(flags: Map<string, string | boolean>): string | undefined {
  const explicit = flags.get("config");
  if (typeof explicit === "string") {
    return explicit;
  }
  const repoId = flags.get("repo");
  if (typeof repoId === "string") {
    return getRepoConfigPath(repoId);
  }
  return undefined;
}

export function defaultRunCommand(command: string, args: string[]): Promise<CommandResult> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return Promise.resolve({
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
}

export function formatCommandFailure(result: CommandResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
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

export async function fetchLocalJson<T>(config: StewardConfig, relativePath: string, options?: { method?: string }): Promise<T> {
  const response = await fetch(
    `http://${config.server.bind}:${config.server.port}${relativePath}`,
    {
      method: options?.method ?? "GET",
      signal: AbortSignal.timeout(2000),
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${relativePath}`);
  }
  return await response.json() as T;
}
