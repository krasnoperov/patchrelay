import pino from "pino";
import type { StewardConfig } from "./config.ts";
import { SqliteStore } from "./db/sqlite-store.ts";
import { CloneManager } from "./github/clone-manager.ts";
import { ShellGitOperations } from "./github/shell-git.ts";
import { GitHubActionsRunner } from "./github/actions-runner.ts";
import { GitHubPRClient } from "./github/pr-client.ts";
import { GitHubCheckRunReporter } from "./github/check-run-reporter.ts";
import { MergeStewardService } from "./service.ts";
import { buildMultiRepoHttpServer } from "./http-multi.ts";
import { loadAllRepoConfigs } from "./install.ts";
import { parseHomeConfigObject } from "./steward-home.ts";
import { getMergeStewardPathLayout } from "./runtime-paths.ts";
import { resolveSecret } from "./resolve-secret.ts";
import { readFileSync, existsSync } from "node:fs";
import type { Logger } from "pino";

export interface RepoInstance {
  config: StewardConfig;
  service: MergeStewardService;
  store: SqliteStore;
}

async function createRepoInstance(config: StewardConfig, logger: Logger): Promise<RepoInstance> {
  const repoUrl = `https://github.com/${config.repoFullName}.git`;
  const clone = new CloneManager(config.clonePath, repoUrl, config.gitBin, logger);
  await clone.ensureClone();
  await clone.fetch();

  const store = new SqliteStore(config.database.path);
  const git = new ShellGitOperations(clone.path, config.gitBin);
  const ci = new GitHubActionsRunner(config.repoFullName, config.requiredChecks);
  const github = new GitHubPRClient(config.repoFullName);
  const eviction = new GitHubCheckRunReporter(
    config.repoFullName,
    config.server.bind,
    config.server.port,
    config.server.publicBaseUrl,
    config.admissionLabel,
  );
  const specBuilder = config.speculativeDepth > 1 ? git : null;
  const service = new MergeStewardService(config, store, git, ci, github, eviction, specBuilder, logger);

  return { config, service, store };
}

export async function startMultiServer(): Promise<void> {
  const layout = getMergeStewardPathLayout();
  const homeRaw = existsSync(layout.configPath) ? readFileSync(layout.configPath, "utf8") : "{}";
  const home = parseHomeConfigObject(homeRaw, layout.configPath);
  const webhookSecret = resolveSecret("merge-steward-webhook-secret", "MERGE_STEWARD_WEBHOOK_SECRET");

  const bind = home.server.bind;
  const port = home.server.gateway_port ?? (home.server.port_base - 1);
  const publicBaseUrl = home.server.public_base_url;
  const logLevel = home.logging.level;

  const logger = pino({ level: logLevel });
  const configs = await loadAllRepoConfigs();

  if (configs.length === 0) {
    logger.warn("No repo configs found. Run `merge-steward attach <id> <owner/repo>` to add repos.");
  }

  for (const config of configs) {
    if (publicBaseUrl) {
      config.server.publicBaseUrl = `${publicBaseUrl.replace(/\/$/, "")}/repos/${config.repoId}`;
    }
  }

  const instances = new Map<string, RepoInstance>();
  for (const config of configs) {
    logger.info({ repoId: config.repoId, repoFullName: config.repoFullName }, "Initializing repo");
    const instance = await createRepoInstance(config, logger.child({ repoId: config.repoId }));
    instances.set(config.repoFullName, instance);
  }

  const app = await buildMultiRepoHttpServer({ instances, webhookSecret, logger });

  const shutdown = async () => {
    logger.info("Shutting down...");
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
    inst.service.start();
  }
}
