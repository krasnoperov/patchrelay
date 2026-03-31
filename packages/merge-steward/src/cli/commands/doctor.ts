import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config.ts";
import { exec } from "../../exec.ts";
import { resolveSecretWithSource } from "../../resolve-secret.ts";
import {
  getDefaultConfigPath,
  getDefaultRepoConfigDir,
  getDefaultRuntimeEnvPath,
  getDefaultServiceEnvPath,
  getDefaultStateDir,
  getRepoConfigPath,
  getSystemdUnitTemplatePath,
} from "../../runtime-paths.ts";
import type { ParsedArgs, Output } from "../types.ts";
import { formatJson, writeOutput } from "../output.ts";
import { getHomeEnv } from "../system.ts";

interface DoctorCheck {
  status: "pass" | "warn" | "fail";
  scope: string;
  message: string;
}

function checkPath(scope: string, targetPath: string, writable = false): DoctorCheck {
  if (!existsSync(targetPath)) {
    return { status: "fail", scope, message: `Missing path: ${targetPath}` };
  }
  try {
    const stats = statSync(targetPath);
    if (!stats.isDirectory() && !stats.isFile()) {
      return { status: "fail", scope, message: `Unexpected path type: ${targetPath}` };
    }
    if (writable) {
      accessSync(stats.isDirectory() ? targetPath : path.dirname(targetPath), constants.W_OK);
    }
    return { status: "pass", scope, message: writable ? `${targetPath} is writable` : `${targetPath} exists` };
  } catch (error) {
    return {
      status: "fail",
      scope,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkExecutable(scope: string, command: string): Promise<DoctorCheck> {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (result.status === 0) {
    return { status: "pass", scope, message: `${command} is available` };
  }
  return { status: "fail", scope, message: `${command} is not available in PATH` };
}

export async function handleDoctor(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const repoId = typeof parsed.flags.get("repo") === "string" ? String(parsed.flags.get("repo")) : undefined;
  const checks: DoctorCheck[] = [];
  const env = getHomeEnv();

  checks.push(checkPath("home-config", getDefaultConfigPath()));
  checks.push(checkPath("runtime-env", getDefaultRuntimeEnvPath()));
  checks.push(checkPath("service-env", getDefaultServiceEnvPath()));
  checks.push(checkPath("repo-config-dir", getDefaultRepoConfigDir(), true));
  checks.push(checkPath("state-dir", getDefaultStateDir(), true));
  checks.push(checkPath("systemd-unit", getSystemdUnitTemplatePath()));
  checks.push(await checkExecutable("git", "git"));
  checks.push(await checkExecutable("gh", "gh"));

  const webhookSecret = resolveSecretWithSource("merge-steward-webhook-secret", "MERGE_STEWARD_WEBHOOK_SECRET", env);
  checks.push({
    status: webhookSecret.value ? "pass" : "warn",
    scope: "webhook-secret",
    message: webhookSecret.value
      ? `Webhook secret resolved from ${webhookSecret.source}`
      : "Webhook secret is missing; signed webhook verification will be disabled",
  });

  const githubToken = resolveSecretWithSource("merge-steward-github-token", "MERGE_STEWARD_GITHUB_TOKEN", env);
  checks.push({
    status: githubToken.value ? "pass" : "fail",
    scope: "github-token",
    message: githubToken.value
      ? `GitHub token resolved from ${githubToken.source}`
      : "GitHub token is missing; steward cannot call gh for merge/check operations",
  });

  let repoConfigPath: string | undefined;
  if (repoId) {
    repoConfigPath = getRepoConfigPath(repoId);
    if (!existsSync(repoConfigPath)) {
      checks.push({ status: "fail", scope: `repo:${repoId}`, message: `Repo config not found: ${repoConfigPath}` });
    } else {
      try {
        const config = loadConfig(repoConfigPath);
        mkdirSync(path.dirname(config.database.path), { recursive: true });
        mkdirSync(path.dirname(config.clonePath), { recursive: true });
        checks.push({ status: "pass", scope: `repo:${repoId}`, message: `Repo config is valid for ${config.repoFullName}` });
        checks.push({
          status: "pass",
          scope: `repo:${repoId}:merge-queue-check`,
          message: `Queue eviction check run is ${config.mergeQueueCheckName}`,
        });
        checks.push(checkPath(`repo:${repoId}:database-dir`, path.dirname(config.database.path), true));
        checks.push(checkPath(`repo:${repoId}:clone-parent`, path.dirname(config.clonePath), true));
        if (githubToken.value) {
          try {
            const auth = await exec("gh", ["api", "user", "--jq", ".login"], {
              allowNonZero: true,
              env: {
                ...process.env,
                ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
              },
            });
            if (auth.exitCode === 0 && auth.stdout.trim()) {
              checks.push({ status: "pass", scope: "github-auth", message: `gh authenticated as ${auth.stdout.trim()}` });
            } else {
              checks.push({ status: "warn", scope: "github-auth", message: "gh did not confirm the current auth identity" });
            }
          } catch (error) {
            checks.push({
              status: "warn",
              scope: "github-auth",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        checks.push({
          status: "fail",
          scope: `repo:${repoId}`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const ok = checks.every((check) => check.status !== "fail");
  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson({ ok, checks, ...(repoConfigPath ? { repoConfigPath } : {}) }));
    return ok ? 0 : 1;
  }

  writeOutput(stdout, `${checks.map((check) => `[${check.status}] ${check.scope}: ${check.message}`).join("\n")}\n`);
  return ok ? 0 : 1;
}
