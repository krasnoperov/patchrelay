import pino from "pino";
import { loadConfig } from "./config.ts";
import { SqliteStore } from "./db/sqlite-store.ts";
import { CloneManager } from "./github/clone-manager.ts";
import { ShellGitOperations } from "./github/shell-git.ts";
import { GitHubActionsRunner } from "./github/actions-runner.ts";
import { GitHubPRClient } from "./github/pr-client.ts";
import { GitHubCheckRunReporter } from "./github/check-run-reporter.ts";
import { MergeStewardService } from "./service.ts";
import { buildHttpServer } from "./http.ts";

export async function startServer(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);

  const logger = pino({
    level: config.logging.level,
  });

  logger.info({ repoId: config.repoId, baseBranch: config.baseBranch }, "Starting merge-steward");

  // Ensure local clone exists.
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
  );

  const specBuilder = config.speculativeDepth > 1 ? git : null;

  const service = new MergeStewardService(
    config, store, git, ci, github, eviction, specBuilder, logger,
  );

  const app = await buildHttpServer(service, config, logger);

  const shutdown = async () => {
    logger.info("Shutting down...");
    await service.stop();
    await app.close();
    store.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await app.listen({ host: config.server.bind, port: config.server.port });
  logger.info({ bind: config.server.bind, port: config.server.port }, "HTTP server listening");

  service.start();
}
