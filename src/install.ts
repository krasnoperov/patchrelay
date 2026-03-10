import crypto from "node:crypto";
import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  getDefaultConfigPath,
  getDefaultDatabasePath,
  getDefaultEnvPath,
  getDefaultLogPath,
  getDefaultWebhookArchiveDir,
  getPatchRelayConfigDir,
  getPatchRelayDataDir,
  getPatchRelayStateDir,
  getSystemdUserUnitPath,
  readBundledAsset,
} from "./runtime-paths.ts";

function renderTemplate(template: string): string {
  const home = homedir();
  const user = basename(home);
  return template
    .replaceAll("${PATCHRELAY_CONFIG:-/home/your-user/.config/patchrelay/patchrelay.yaml}", getDefaultConfigPath())
    .replaceAll("${PATCHRELAY_DB_PATH:-/home/your-user/.local/state/patchrelay/patchrelay.sqlite}", getDefaultDatabasePath())
    .replaceAll("${PATCHRELAY_LOG_FILE:-/home/your-user/.local/state/patchrelay/patchrelay.log}", getDefaultLogPath())
    .replaceAll("/home/your-user/.config/patchrelay/.env", getDefaultEnvPath())
    .replaceAll("/home/your-user/.config/patchrelay/patchrelay.yaml", getDefaultConfigPath())
    .replaceAll("/home/your-user/.config/patchrelay", getPatchRelayConfigDir())
    .replaceAll("/home/your-user/.local/state/patchrelay/webhooks", getDefaultWebhookArchiveDir())
    .replaceAll("/home/your-user/.local/state/patchrelay", getPatchRelayStateDir())
    .replaceAll("/home/your-user/.local/share/patchrelay", getPatchRelayDataDir())
    .replaceAll("/home/your-user", home)
    .replaceAll("your-user", user);
}

function generateSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function renderEnvTemplate(template: string): string {
  return template
    .replace(
      "LINEAR_WEBHOOK_SECRET=replace-with-linear-webhook-secret",
      `LINEAR_WEBHOOK_SECRET=${generateSecret()}`,
    )
    .replace(
      "PATCHRELAY_TOKEN_ENCRYPTION_KEY=replace-with-long-random-secret",
      `PATCHRELAY_TOKEN_ENCRYPTION_KEY=${generateSecret()}`,
    );
}

async function writeTemplateFile(targetPath: string, content: string, force: boolean): Promise<"created" | "skipped"> {
  if (!force && existsSync(targetPath)) {
    return "skipped";
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return "created";
}

export async function initializePatchRelayHome(options?: { force?: boolean }): Promise<{
  configDir: string;
  envPath: string;
  configPath: string;
  stateDir: string;
  dataDir: string;
  envStatus: "created" | "skipped";
  configStatus: "created" | "skipped";
}> {
  const force = options?.force ?? false;
  const configDir = getPatchRelayConfigDir();
  const envPath = getDefaultEnvPath();
  const configPath = getDefaultConfigPath();
  const stateDir = getPatchRelayStateDir();
  const dataDir = getPatchRelayDataDir();

  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const envTemplate = renderEnvTemplate(readBundledAsset(".env.example"));
  const configTemplate = renderTemplate(readBundledAsset("config/patchrelay.example.yaml"));

  const envStatus = await writeTemplateFile(envPath, envTemplate, force);
  const configStatus = await writeTemplateFile(configPath, configTemplate, force);

  return {
    configDir,
    envPath,
    configPath,
    stateDir,
    dataDir,
    envStatus,
    configStatus,
  };
}

export async function installUserServiceUnit(options?: { force?: boolean }): Promise<{
  unitPath: string;
  envPath: string;
  configPath: string;
  status: "created" | "skipped";
}> {
  const force = options?.force ?? false;
  const unitPath = getSystemdUserUnitPath();
  const status = await writeTemplateFile(unitPath, renderTemplate(readBundledAsset("infra/patchrelay.service")), force);
  return {
    unitPath,
    envPath: getDefaultEnvPath(),
    configPath: getDefaultConfigPath(),
    status,
  };
}
