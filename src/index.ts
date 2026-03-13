#!/usr/bin/env node

import { dirname } from "node:path";
import { runCli } from "./cli/index.ts";

async function main(): Promise<void> {
  const cliExitCode = await runCli(process.argv.slice(2));
  if (cliExitCode !== -1) {
    process.exitCode = cliExitCode;
    return;
  }

  const [
    { CodexAppServerClient },
    { getAdjacentEnvFilePaths, loadConfig },
    { PatchRelayDatabase },
    { enforceRuntimeFilePermissions, enforceServiceEnvPermissions },
    { buildHttpServer },
    { DatabaseBackedLinearClientProvider },
    { createLogger },
    { runPreflight },
    { PatchRelayService },
    { ensureDir },
  ] = await Promise.all([
    import("./codex-app-server.ts"),
    import("./config.ts"),
    import("./db.ts"),
    import("./file-permissions.ts"),
    import("./http.ts"),
    import("./linear-client.ts"),
    import("./logging.ts"),
    import("./preflight.ts"),
    import("./service.ts"),
    import("./utils.ts"),
  ]);

  const configPath = process.env.PATCHRELAY_CONFIG;
  const config = loadConfig(configPath);
  await enforceServiceEnvPermissions(getAdjacentEnvFilePaths(configPath).serviceEnvPath);
  await ensureDir(dirname(config.database.path));
  await ensureDir(dirname(config.logging.filePath));
  if (config.logging.webhookArchiveDir) {
    await ensureDir(config.logging.webhookArchiveDir);
  }
  for (const project of config.projects) {
    await ensureDir(project.worktreeRoot);
  }
  await enforceRuntimeFilePermissions(config);

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

  try {
    await app.listen({
      host: config.server.bind,
      port: config.server.port,
    });
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "EADDRINUSE") {
      throw new Error(
        `Port ${config.server.port} on ${config.server.bind} is already in use. ` +
        `Another patchrelay process may be running. Check with: ss -tlnp | grep ${config.server.port}`,
        { cause: error },
      );
    }
    throw error;
  }

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
