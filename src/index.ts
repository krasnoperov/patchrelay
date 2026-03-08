import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { PatchRelayDatabase } from "./db.js";
import { buildHttpServer } from "./http.js";
import { LaunchRunner } from "./launcher.js";
import { createLogger } from "./logging.js";
import { PatchRelayService } from "./service.js";
import { ensureDir } from "./utils.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureDir(dirname(config.database.path));
  await ensureDir(dirname(config.logging.filePath));
  if (config.logging.webhookArchiveDir) {
    await ensureDir(config.logging.webhookArchiveDir);
  }

  const logger = createLogger(config);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();

  const launcher = new LaunchRunner(config, db, logger, `${process.pid}`);
  const service = new PatchRelayService(config, db, launcher, logger);
  await service.start();
  const app = await buildHttpServer(config, service, logger);

  await app.listen({
    host: config.server.bind,
    port: config.server.port,
  });

  logger.info(
    {
      bind: config.server.bind,
      port: config.server.port,
      webhookPath: config.ingress.linearWebhookPath,
      configPath: process.env.PATCHRELAY_CONFIG,
    },
    "PatchRelay started",
  );

  const shutdown = async (): Promise<void> => {
    service.stop();
    await app.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
