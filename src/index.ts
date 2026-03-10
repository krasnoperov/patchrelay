#!/usr/bin/env node

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli/index.ts";
import { CodexAppServerClient } from "./codex-app-server.ts";
import { loadConfig } from "./config.ts";
import { PatchRelayDatabase } from "./db.ts";
import { buildHttpServer } from "./http.ts";
import { DatabaseBackedLinearClientProvider } from "./linear-client.ts";
import { createLogger } from "./logging.ts";
import { runPreflight } from "./preflight.ts";
import { PatchRelayService } from "./service.ts";
import { ensureDir } from "./utils.ts";

async function main(): Promise<void> {
  const cliExitCode = await runCli(process.argv.slice(2));
  if (cliExitCode !== -1) {
    process.exitCode = cliExitCode;
    return;
  }

  const config = loadConfig();
  await ensureDir(dirname(config.database.path));
  await ensureDir(dirname(config.logging.filePath));
  if (config.logging.webhookArchiveDir) {
    await ensureDir(config.logging.webhookArchiveDir);
  }
  for (const project of config.projects) {
    await ensureDir(project.worktreeRoot);
  }

  const preflight = await runPreflight(config);
  const failedChecks = preflight.checks.filter((check) => check.status === "fail");
  if (failedChecks.length > 0) {
    throw new Error(
      ["PatchRelay startup preflight failed:", ...failedChecks.map((check) => `- [${check.scope}] ${check.message}`)].join("\n"),
    );
  }

  const logger = createLogger(config);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();

  const codex = new CodexAppServerClient(config.runner.codex, logger);
  const linearProvider = new DatabaseBackedLinearClientProvider(config, db, logger);
  const service = new PatchRelayService(config, db, codex, linearProvider, logger);
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
