import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config.ts";
import { normalizeCheckList } from "../../github-repo-discovery.ts";
import {
  getDefaultConfigPath,
  getDefaultRepoConfigDir,
  getDefaultRuntimeEnvPath,
  getDefaultServiceEnvPath,
  getDefaultStateDir,
  getRepoConfigPath,
  getSystemdUnitPath,
} from "../../runtime-paths.ts";
import type { ParsedArgs, Output } from "../types.ts";
import { formatJson, writeOutput } from "../output.ts";
import { fetchServiceGitHubAuthStatus, fetchServiceRepoDiscovery, getHomeEnv } from "../system.ts";

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
  checks.push(checkPath("systemd-unit", getSystemdUnitPath()));
  checks.push(await checkExecutable("git", "git"));
  checks.push(await checkExecutable("gh", "gh"));

  const appId = env.MERGE_STEWARD_GITHUB_APP_ID?.trim();
  checks.push({
    status: appId ? "pass" : "fail",
    scope: "github-app-id",
    message: appId
      ? `GitHub App id configured: ${appId}`
      : "GitHub App id is missing; set MERGE_STEWARD_GITHUB_APP_ID in service.env",
  });

  let serviceGitHubStatus:
    | {
      mode: "none" | "app";
      configured: boolean;
      ready: boolean;
      webhookSecretConfigured: boolean;
      appId?: string;
      installationMode?: "pinned" | "per_repo";
      error?: string;
    }
    | undefined;
  try {
    serviceGitHubStatus = await fetchServiceGitHubAuthStatus();
    checks.push({
      status: "pass",
      scope: "service-admin",
      message: "Local merge-steward service is reachable",
    });
  } catch (error) {
    checks.push({
      status: "warn",
      scope: "service-admin",
      message: `Local merge-steward service is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (serviceGitHubStatus) {
    checks.push({
      status: serviceGitHubStatus.webhookSecretConfigured ? "pass" : "warn",
      scope: "webhook-secret",
      message: serviceGitHubStatus.webhookSecretConfigured
        ? "Webhook secret is configured in the running service"
        : "Webhook secret is not configured in the running service; signed webhook verification will be disabled",
    });
    checks.push({
      status: serviceGitHubStatus.ready ? "pass" : "fail",
      scope: "github-auth",
      message: serviceGitHubStatus.ready
        ? serviceGitHubStatus.mode === "app" && serviceGitHubStatus.appId
          ? `Service GitHub auth is ready from App ${serviceGitHubStatus.appId}`
          : "Service GitHub auth is ready"
        : serviceGitHubStatus.error ?? "Service GitHub auth is not ready",
    });
    if (serviceGitHubStatus.mode === "app") {
      checks.push({
        status: "pass",
        scope: "github-app",
        message: serviceGitHubStatus.installationMode === "pinned"
          ? "GitHub App installation id is pinned in the running service"
          : "GitHub App installation will be resolved per repository by the running service",
      });
    }
  } else {
    checks.push({
      status: appId ? "warn" : "fail",
      scope: "github-auth",
      message: appId
        ? "Service runtime GitHub auth could not be verified because the local merge-steward service is unavailable"
        : "GitHub auth is not configured",
    });
  }

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
        if (serviceGitHubStatus) {
          try {
            const response = await fetchServiceRepoDiscovery(config.repoFullName, { baseBranch: config.baseBranch });
            const discovered = response.discovery;
            checks.push({
              status: discovered.defaultBranch === config.baseBranch ? "pass" : "warn",
              scope: `repo:${repoId}:github-default-branch`,
              message: discovered.defaultBranch === config.baseBranch
                ? `Local base branch matches GitHub default branch (${discovered.defaultBranch})`
                : `Local base branch is ${config.baseBranch}, but GitHub default branch is ${discovered.defaultBranch}`,
            });

            const configuredChecks = normalizeCheckList(config.requiredChecks);
            const discoveredChecks = normalizeCheckList(discovered.requiredChecks);
            const checksMatch = configuredChecks.length === discoveredChecks.length
              && configuredChecks.every((value, index) => value === discoveredChecks[index]);
            checks.push({
              status: checksMatch ? "pass" : "warn",
              scope: `repo:${repoId}:github-required-checks`,
              message: checksMatch
                ? (configuredChecks.length > 0
                    ? `Local required checks match GitHub for ${config.baseBranch}`
                    : `No required checks configured locally and GitHub does not require status checks for ${config.baseBranch}`)
                : `Local required checks [${configuredChecks.join(", ") || "(none)"}] differ from GitHub [${discoveredChecks.join(", ") || "(none)"}] for ${config.baseBranch}`,
            });

            for (const warning of discovered.warnings) {
              checks.push({
                status: "warn",
                scope: `repo:${repoId}:github-discovery`,
                message: warning,
              });
            }
          } catch (error) {
            checks.push({
              status: "warn",
              scope: `repo:${repoId}:github-discovery`,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          checks.push({
            status: "warn",
            scope: `repo:${repoId}:github-discovery`,
            message: "Skipped GitHub drift checks because the local merge-steward service is unavailable",
          });
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
