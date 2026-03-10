import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.ts";
import { execCommand } from "./utils.ts";

export interface PreflightCheck {
  status: "pass" | "warn" | "fail";
  scope: string;
  message: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  ok: boolean;
}

export async function runPreflight(config: AppConfig): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];

  if (!config.linear.webhookSecret) {
    checks.push(fail("linear", "LINEAR_WEBHOOK_SECRET is missing"));
  } else {
    checks.push(pass("linear", "Linear webhook secret is configured"));
  }
  if (!config.linear.oauth.clientId) {
    checks.push(fail("linear_oauth", "LINEAR_OAUTH_CLIENT_ID is missing"));
  } else {
    checks.push(pass("linear_oauth", `Linear OAuth is configured with actor=${config.linear.oauth.actor}`));
  }
  if (!config.linear.oauth.clientSecret) {
    checks.push(fail("linear_oauth", "LINEAR_OAUTH_CLIENT_SECRET is missing"));
  } else {
    checks.push(pass("linear_oauth", "Linear OAuth client secret is configured"));
  }
  if (!config.linear.tokenEncryptionKey) {
    checks.push(fail("linear_oauth", "PATCHRELAY_TOKEN_ENCRYPTION_KEY is missing"));
  } else {
    checks.push(pass("linear_oauth", "Token encryption key is configured"));
  }

  if (config.operatorApi.enabled) {
    if (config.operatorApi.bearerToken) {
      checks.push(pass("operator_api", "Operator API is enabled with bearer token protection"));
    } else if (config.server.bind === "127.0.0.1") {
      checks.push(warn("operator_api", "Operator API is enabled without a bearer token; safe only on loopback binds"));
    } else {
      checks.push(fail("operator_api", "Operator API is enabled without a bearer token on a non-loopback bind"));
    }
  } else {
    checks.push(pass("operator_api", "Operator API is disabled"));
  }

  checks.push(...checkPath("database", path.dirname(config.database.path), "directory", { createIfMissing: true, writable: true }));
  checks.push(...checkPath("logging", path.dirname(config.logging.filePath), "directory", { createIfMissing: true, writable: true }));
  if (config.logging.webhookArchiveDir) {
    checks.push(...checkPath("archive", config.logging.webhookArchiveDir, "directory", { createIfMissing: true, writable: true }));
  } else {
    checks.push(warn("archive", "Raw webhook archival is disabled"));
  }

  for (const project of config.projects) {
    checks.push(...checkPath(`project:${project.id}:repo`, project.repoPath, "directory", { writable: true }));
    checks.push(...checkPath(`project:${project.id}:worktrees`, project.worktreeRoot, "directory", { createIfMissing: true, writable: true }));
    checks.push(...checkPath(`project:${project.id}:workflow:development`, project.workflowFiles.development, "file", {}));
    checks.push(...checkPath(`project:${project.id}:workflow:review`, project.workflowFiles.review, "file", {}));
    checks.push(...checkPath(`project:${project.id}:workflow:deploy`, project.workflowFiles.deploy, "file", {}));
    checks.push(...checkPath(`project:${project.id}:workflow:cleanup`, project.workflowFiles.cleanup, "file", {}));
  }

  checks.push(await checkExecutable("git", config.runner.gitBin));
  checks.push(await checkExecutable("codex", config.runner.codex.bin));

  return {
    checks,
    ok: checks.every((check) => check.status !== "fail"),
  };
}

function checkPath(
  scope: string,
  targetPath: string,
  expectedType: "file" | "directory",
  options: { createIfMissing?: boolean; writable?: boolean },
): PreflightCheck[] {
  const checks: PreflightCheck[] = [];

  if (!existsSync(targetPath)) {
    if (expectedType === "directory" && options.createIfMissing) {
      try {
        mkdirSync(targetPath, { recursive: true });
        checks.push(pass(scope, `Created missing directory ${targetPath}`));
      } catch (error) {
        checks.push(fail(scope, `Unable to create directory ${targetPath}: ${formatError(error)}`));
        return checks;
      }
    } else {
      checks.push(fail(scope, `Missing ${expectedType}: ${targetPath}`));
      return checks;
    }
  }

  let stats;
  try {
    stats = statSync(targetPath);
  } catch (error) {
    checks.push(fail(scope, `Unable to stat ${targetPath}: ${formatError(error)}`));
    return checks;
  }

  if (expectedType === "file" && !stats.isFile()) {
    checks.push(fail(scope, `Expected a file: ${targetPath}`));
    return checks;
  }
  if (expectedType === "directory" && !stats.isDirectory()) {
    checks.push(fail(scope, `Expected a directory: ${targetPath}`));
    return checks;
  }

  if (options.writable) {
    try {
      accessSync(targetPath, constants.W_OK);
      checks.push(pass(scope, `${targetPath} is writable`));
    } catch (error) {
      checks.push(fail(scope, `${targetPath} is not writable: ${formatError(error)}`));
      return checks;
    }
  } else {
    checks.push(pass(scope, `${targetPath} exists`));
  }

  return checks;
}

async function checkExecutable(scope: string, command: string): Promise<PreflightCheck> {
  try {
    const result = await execCommand(command, ["--version"], {
      timeoutMs: 5000,
    });
    if (result.exitCode !== 0) {
      return fail(scope, `${command} --version exited with ${result.exitCode}`);
    }

    const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim() || "version command succeeded";
    return pass(scope, `${command} available: ${firstLine}`);
  } catch (error) {
    return fail(scope, `${command} is not executable: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pass(scope: string, message: string): PreflightCheck {
  return {
    status: "pass",
    scope,
    message,
  };
}

function warn(scope: string, message: string): PreflightCheck {
  return {
    status: "warn",
    scope,
    message,
  };
}

function fail(scope: string, message: string): PreflightCheck {
  return {
    status: "fail",
    scope,
    message,
  };
}
