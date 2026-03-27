import pino from "pino";
import { loadConfig } from "./config.ts";
import { SqliteStore } from "./db/sqlite-store.ts";
import { ShellGitOperations } from "./github/shell-git.ts";
import { GitHubActionsRunner } from "./github/actions-runner.ts";
import { GitHubPRClient } from "./github/pr-client.ts";
import { EvictionReporterSim } from "./sim/github-sim.ts";
import { MergeStewardService } from "./service.ts";
import { buildHttpServer } from "./http.ts";

export async function startServer(configPath?: string): Promise<void> {
  const config = loadConfig(configPath);

  const logger = pino({
    level: config.logging.level,
  });

  logger.info({ repoId: config.repoId, baseBranch: config.baseBranch }, "Starting merge-steward");

  const store = new SqliteStore(config.database.path);
  const git = new ShellGitOperations(config.worktreeRoot, config.gitBin);
  const ci = new GitHubActionsRunner(config.repoFullName, config.requiredChecks);
  const github = new GitHubPRClient(config.repoFullName);

  // Eviction reporter: logs evictions for now. Real implementation will
  // create GitHub check runs (next PR).
  const eviction = new EvictionReporterSim();

  const service = new MergeStewardService(
    config, store, git, ci, github, eviction, logger,
  );

  const app = await buildHttpServer(service, logger);

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
