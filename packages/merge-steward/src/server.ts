import pino from "pino";
import type { RuntimeStewardConfig, StewardConfig } from "./config.ts";
import { SqliteStore } from "./db/sqlite-store.ts";
import { CloneManager } from "./github/clone-manager.ts";
import { ShellGitOperations, type BotIdentity } from "./github/shell-git.ts";
import { GitHubActionsRunner } from "./github/actions-runner.ts";
import { GitHubPRClient } from "./github/pr-client.ts";
import { GitHubCheckRunReporter } from "./github/check-run-reporter.ts";
import { MergeStewardService } from "./service.ts";
import { buildMultiRepoHttpServer } from "./http-multi.ts";
import { loadAllRepoConfigs } from "./install.ts";
import { parseHomeConfigObject } from "./steward-home.ts";
import { getMergeStewardPathLayout } from "./runtime-paths.ts";
import { createGitHubAppTokenManager, generateJwt, resolveGitHubAuthConfig, resolveAppSlug, type GitHubAppTokenManager } from "./github-auth.ts";
import { discoverRepoSettings } from "./github-repo-discovery.ts";
import { resolveSecret, resolveSecretWithSource } from "./resolve-secret.ts";
import { setRuntimeGitHubAuthProvider } from "./exec.ts";
import { readFileSync, existsSync } from "node:fs";
import type { Logger } from "pino";
import type { ServiceGitHubAuthStatus, ServiceGitHubRepoAccessResponse } from "./admin-types.ts";

export interface RepoInstance {
  config: RuntimeStewardConfig;
  service: MergeStewardService;
  store: SqliteStore;
}

async function createRepoInstance(config: RuntimeStewardConfig, logger: Logger, botIdentity?: BotIdentity): Promise<RepoInstance> {
  const repoUrl = `https://github.com/${config.repoFullName}.git`;
  const clone = new CloneManager(config.clonePath, repoUrl, config.repoFullName, config.gitBin, logger);
  await clone.ensureClone();
  await clone.fetch();

  const store = new SqliteStore(config.database.path);
  const git = new ShellGitOperations(clone.path, config.repoFullName, config.gitBin);
  if (botIdentity) git.setBotIdentity(botIdentity);
  if (config.autoResolvePatterns.length > 0) git.setAutoResolvePatterns(config.autoResolvePatterns);
  const ci = new GitHubActionsRunner(config.repoFullName, config.githubRequiredChecks);
  const github = new GitHubPRClient(config.repoFullName);
  const eviction = new GitHubCheckRunReporter(
    config.repoFullName,
    config.server.bind,
    config.server.port,
    config.server.publicBaseUrl,
    config.admissionLabel,
    config.mergeQueueCheckName,
  );
  const service = new MergeStewardService(config, store, git, ci, github, eviction, git, logger);

  return { config, service, store };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGitHubJson<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${body}`);
  }
  return await response.json() as T;
}

function normalizePermissionLevel(value: unknown): "none" | "read" | "write" {
  if (value === "write") return "write";
  if (value === "read") return "read";
  return "none";
}

export async function startMultiServer(): Promise<void> {
  const layout = getMergeStewardPathLayout();
  const homeRaw = existsSync(layout.configPath) ? readFileSync(layout.configPath, "utf8") : "{}";
  const home = parseHomeConfigObject(homeRaw, layout.configPath);
  const webhookSecretResolved = resolveSecretWithSource("merge-steward-webhook-secret", "MERGE_STEWARD_WEBHOOK_SECRET");
  const webhookSecret = webhookSecretResolved.value;

  const bind = home.server.bind;
  const port = home.server.gateway_port ?? (home.server.port_base - 1);
  const publicBaseUrl = home.server.public_base_url;
  const logLevel = home.logging.level;

  const logger = pino({ level: logLevel });
  logger.info({
    webhookSecretSource: webhookSecretResolved.source,
    webhookSecretPrefix: webhookSecret?.slice(0, 4) ?? "NONE",
  }, "Webhook secret loaded");
  const configs = await loadAllRepoConfigs();
  const githubAuth = resolveGitHubAuthConfig();
  let githubAppTokenManager: GitHubAppTokenManager | undefined;
  let botIdentity: BotIdentity | undefined;
  let githubRuntimeStatus: ServiceGitHubAuthStatus = {
    mode: "none",
    configured: false,
    ready: false,
    webhookSecretConfigured: Boolean(webhookSecret),
  };
  setRuntimeGitHubAuthProvider(undefined);

  if (configs.length === 0) {
    logger.warn("No repo configs found. Run `merge-steward attach <owner/repo>` to add repos.");
  }

  if (githubAuth.mode === "app") {
    githubRuntimeStatus = {
      mode: "app",
      configured: true,
      ready: false,
      webhookSecretConfigured: Boolean(webhookSecret),
      appId: githubAuth.credentials.appId,
      installationMode: githubAuth.credentials.installationId ? "pinned" : "per_repo",
    };
    githubAppTokenManager = createGitHubAppTokenManager(
      githubAuth.credentials,
      configs.map((config) => config.repoFullName),
      logger.child({ component: "github-auth" }),
    );
    setRuntimeGitHubAuthProvider(githubAppTokenManager);
    try {
      await githubAppTokenManager.start();
      try {
        const slug = await resolveAppSlug(githubAuth.credentials);
        botIdentity = {
          name: `${slug}[bot]`,
          email: `${githubAuth.credentials.appId}+${slug}[bot]@users.noreply.github.com`,
        };
        logger.info({ botName: botIdentity.name }, "Resolved GitHub App bot identity");
      } catch {
        logger.warn("Could not resolve GitHub App slug, merge commits will use clone owner identity");
      }
      githubRuntimeStatus = {
        ...githubRuntimeStatus,
        ready: true,
      };
      logger.info({ mode: "app" }, "Using GitHub App authentication");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      githubRuntimeStatus = {
        ...githubRuntimeStatus,
        ready: false,
        error: message,
      };
      githubAppTokenManager = undefined;
      setRuntimeGitHubAuthProvider(undefined);
      logger.warn({ error: message }, "GitHub App auth is configured but not ready");
    }
  } else {
    githubRuntimeStatus = {
      ...githubRuntimeStatus,
      error: "GitHub App auth is not configured",
    };
    logger.warn("No GitHub App auth configured. GitHub operations will fail until auth is configured.");
  }

  for (const config of configs) {
    if (publicBaseUrl) {
      config.server.publicBaseUrl = `${publicBaseUrl.replace(/\/$/, "")}/repos/${config.repoId}`;
    }
  }

  const instances = new Map<string, RepoInstance>();
  for (const config of configs) {
    logger.info({ repoId: config.repoId, repoFullName: config.repoFullName }, "Initializing repo");
    const discovery = githubAuth.mode === "app"
      ? await discoverRepoSettings(githubAuth.credentials, config.repoFullName, { baseBranch: config.baseBranch })
      : { defaultBranch: config.baseBranch, branch: config.baseBranch, requiredChecks: [], warnings: [] };
    const runtimeConfig: RuntimeStewardConfig = {
      ...config,
      githubRequiredChecks: discovery.requiredChecks,
    };
    logger.info({
      repoId: config.repoId,
      repoFullName: config.repoFullName,
      githubRequiredChecks: runtimeConfig.githubRequiredChecks,
    }, "Resolved GitHub protection requirements");
    const instance = await createRepoInstance(runtimeConfig, logger.child({ repoId: config.repoId }), botIdentity);
    instances.set(config.repoFullName, instance);
  }

  const app = await buildMultiRepoHttpServer({
    instances,
    webhookSecret,
    githubAdmin: {
      getStatus: () => githubRuntimeStatus,
      async discoverRepoSettings(params) {
        if (githubAuth.mode !== "app") {
          throw new Error("GitHub App auth is not configured in the merge-steward service.");
        }
        return await discoverRepoSettings(githubAuth.credentials, params.repoFullName, {
          ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
        });
      },
      async checkRepoAccess(params): Promise<ServiceGitHubRepoAccessResponse> {
        if (!githubAppTokenManager) {
          throw new Error("GitHub App auth is not ready in the merge-steward service.");
        }
        if (githubAuth.mode !== "app") {
          throw new Error("GitHub App auth is not configured in the merge-steward service.");
        }
        const encodedRepo = params.repoFullName.split("/").map(encodeURIComponent).join("/");
        const appJwt = generateJwt(githubAuth.credentials.appId, githubAuth.credentials.privateKey);
        const installation = await fetchGitHubJson<{
          permissions?: { contents?: string };
        }>(appJwt, `/repos/${encodedRepo}/installation`);
        const token = githubAppTokenManager.currentTokenForRepo(params.repoFullName);
        if (!token) {
          throw new Error(`No GitHub installation token available for ${params.repoFullName}.`);
        }
        const branch = await fetchGitHubJson<{ protected?: boolean }>(
          token,
          `/repos/${encodedRepo}/branches/${encodeURIComponent(params.baseBranch)}`,
        );
        const contents = normalizePermissionLevel(installation.permissions?.contents);
        return {
          ok: true,
          repoFullName: params.repoFullName,
          baseBranch: params.baseBranch,
          permissions: {
            contents,
            pull: contents === "read" || contents === "write",
            push: contents === "write",
            admin: false,
          },
          branchProtected: Boolean(branch.protected),
        };
      },
    },
    logger,
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    githubAppTokenManager?.stop();
    setRuntimeGitHubAuthProvider(undefined);
    for (const inst of instances.values()) {
      await inst.service.stop();
      inst.store.close();
    }
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await app.listen({ host: bind, port });
  logger.info({ bind, port, repos: instances.size }, "merge-steward listening");

  for (const inst of instances.values()) {
    await inst.service.start();
  }
}
