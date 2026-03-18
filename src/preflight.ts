import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { runPatchRelayMigrations } from "./db/migrations.ts";
import { SqliteConnection } from "./db/shared.ts";
import type { AppConfig } from "./types.ts";
import { execCommand } from "./utils.ts";
import { listProjectWorkflowDefinitions } from "./workflow-policy.ts";

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
  if (config.linear.oauth.actor === "app") {
    const scopes = new Set(config.linear.oauth.scopes);
    const missingScopes = ["app:assignable", "app:mentionable"].filter((scope) => !scopes.has(scope));
    if (missingScopes.length > 0) {
      checks.push(warn("linear_oauth", `Linear app actor is missing recommended agent scopes: ${missingScopes.join(", ")}`));
    } else {
      checks.push(pass("linear_oauth", "Linear app actor includes assignable and mentionable scopes"));
    }
    for (const project of config.projects) {
      if (!project.triggerEvents.includes("delegateChanged")) {
        checks.push(
          warn(
            `project:${project.id}:triggers`,
            "Automatic pipeline pickup works best when trigger_events includes delegateChanged",
          ),
        );
      }
      if (!project.triggerEvents.includes("statusChanged")) {
        checks.push(
          warn(
            `project:${project.id}:triggers`,
            "Automatic stage-to-stage continuation works best when trigger_events includes statusChanged",
          ),
        );
      }
      if (!project.triggerEvents.includes("agentSessionCreated")) {
        checks.push(
          warn(
            `project:${project.id}:triggers`,
            "Native Linear agent sessions work best when trigger_events includes agentSessionCreated",
          ),
        );
      }
      if (!project.triggerEvents.includes("agentPrompted")) {
        checks.push(
          warn(
            `project:${project.id}:triggers`,
            "Native follow-up agent prompts will not reach an active run unless trigger_events includes agentPrompted",
          ),
        );
      }
    }
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

  checks.push(...checkPublicBaseUrl(config));
  checks.push(...checkOAuthRedirectUri(config));

  checks.push(...checkPath("database", path.dirname(config.database.path), "directory", { createIfMissing: true, writable: true }));
  checks.push(checkDatabaseSchema(config));
  checks.push(...checkPath("logging", path.dirname(config.logging.filePath), "directory", { createIfMissing: true, writable: true }));
  if (config.projects.length === 0) {
    checks.push(warn("projects", "No projects are configured yet; add one with `patchrelay project apply <id> <repo-path>` before connecting Linear"));
  }

  for (const project of config.projects) {
    checks.push(...checkPath(`project:${project.id}:repo`, project.repoPath, "directory", { writable: true }));
    checks.push(...checkPath(`project:${project.id}:worktrees`, project.worktreeRoot, "directory", { createIfMissing: true, writable: true }));
    for (const definition of listProjectWorkflowDefinitions(project)) {
      for (const workflow of definition.stages) {
        checks.push(...checkPath(`project:${project.id}:workflow:${definition.id}:${workflow.id}`, workflow.workflowFile, "file", {}));
      }
    }
  }

  checks.push(await checkExecutable("git", config.runner.gitBin));
  checks.push(await checkExecutable("codex", config.runner.codex.bin));

  return {
    checks,
    ok: checks.every((check) => check.status !== "fail"),
  };
}

function checkDatabaseSchema(config: AppConfig): PreflightCheck {
  let connection: SqliteConnection | undefined;
  try {
    connection = new SqliteConnection(config.database.path);
    connection.pragma("foreign_keys = ON");
    if (config.database.wal) {
      connection.pragma("journal_mode = WAL");
    }

    runPatchRelayMigrations(connection);

    const quickCheck = connection.prepare("PRAGMA quick_check").get();
    const quickCheckResult = quickCheck ? Object.values(quickCheck)[0] : undefined;
    if (quickCheckResult !== "ok") {
      return fail("database_schema", `SQLite quick_check failed: ${String(quickCheckResult ?? "unknown result")}`);
    }

    const schemaStats = connection
      .prepare(
        `
        SELECT
          COUNT(*) AS object_count
        FROM sqlite_master
        WHERE type IN ('table', 'index', 'view', 'trigger')
          AND name NOT LIKE 'sqlite_%'
        `,
      )
      .get();
    const objectCount = Number(schemaStats?.object_count ?? 0);
    if (objectCount < 1) {
      return fail("database_schema", "Database schema is empty after migrations");
    }

    return pass("database_schema", `Database opened, migrations applied, and schema is readable (${objectCount} objects)`);
  } catch (error) {
    return fail("database_schema", `Unable to open or validate database schema at ${config.database.path}: ${formatError(error)}`);
  } finally {
    connection?.close();
  }
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

function checkPublicBaseUrl(config: AppConfig): PreflightCheck[] {
  const publicBaseUrl = config.server.publicBaseUrl;
  if (!publicBaseUrl) {
    return [
      warn(
        "public_url",
        "server.public_base_url is not configured; set it to the public HTTPS origin that Linear should call",
      ),
    ];
  }

  try {
    const url = new URL(publicBaseUrl);
    const checks: PreflightCheck[] = [pass("public_url", `Public base URL configured: ${url.origin}`)];

    if (url.protocol !== "https:") {
      checks.push(warn("public_url", "server.public_base_url is not HTTPS; Linear-facing ingress should usually be HTTPS"));
    }

    if (isLoopbackHost(url.hostname)) {
      checks.push(warn("public_url", "server.public_base_url points at a loopback host and will not be reachable by Linear"));
    }

    if (url.pathname !== "/" && url.pathname !== "") {
      checks.push(warn("public_url", "server.public_base_url path is ignored; use only scheme, host, and optional port"));
    }

    return checks;
  } catch (error) {
    return [fail("public_url", `Invalid server.public_base_url: ${formatError(error)}`)];
  }
}

function checkOAuthRedirectUri(config: AppConfig): PreflightCheck[] {
  try {
    const url = new URL(config.linear.oauth.redirectUri);
    const checks: PreflightCheck[] = [];

    if (url.pathname !== "/oauth/linear/callback") {
      checks.push(fail("linear_oauth", 'linear.oauth.redirect_uri must use the fixed "/oauth/linear/callback" path'));
      return checks;
    }

    if (isLoopbackHost(url.hostname)) {
      checks.push(pass("linear_oauth", "Linear OAuth redirect URI is configured for local callback handling"));
    } else {
      checks.push(pass("linear_oauth", `Linear OAuth redirect URI is configured for public callback handling at ${url.origin}`));
      if (url.protocol !== "https:") {
        checks.push(warn("linear_oauth", "Public Linear OAuth redirect URIs should usually use HTTPS"));
      }
    }

    return checks;
  } catch (error) {
    return [fail("linear_oauth", `Invalid linear.oauth.redirect_uri: ${formatError(error)}`)];
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
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
