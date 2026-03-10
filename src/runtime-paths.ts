import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAbsolutePath } from "./utils.ts";

export interface PatchRelayPathLayout {
  homeDir: string;
  configDir: string;
  configPath: string;
  envPath: string;
  stateDir: string;
  shareDir: string;
  databasePath: string;
  logFilePath: string;
  systemdUserDir: string;
  systemdUnitPath: string;
}

export function getPatchRelayPathLayout(): PatchRelayPathLayout {
  const homeDir = homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
  const xdgStateHome = process.env.XDG_STATE_HOME ?? path.join(homeDir, ".local", "state");
  const xdgDataHome = process.env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share");

  const configPath = ensureAbsolutePath(process.env.PATCHRELAY_CONFIG ?? path.join(xdgConfigHome, "patchrelay", "patchrelay.yaml"));
  const configDir = path.dirname(configPath);
  const envPath = path.join(configDir, ".env");
  const stateDir = path.join(xdgStateHome, "patchrelay");
  const shareDir = path.join(xdgDataHome, "patchrelay");
  const systemdUserDir = path.join(xdgConfigHome, "systemd", "user");

  return {
    homeDir,
    configDir,
    configPath,
    envPath,
    stateDir,
    shareDir,
    databasePath: ensureAbsolutePath(process.env.PATCHRELAY_DB_PATH ?? path.join(stateDir, "patchrelay.sqlite")),
    logFilePath: ensureAbsolutePath(process.env.PATCHRELAY_LOG_FILE ?? path.join(stateDir, "patchrelay.log")),
    systemdUserDir,
    systemdUnitPath: path.join(systemdUserDir, "patchrelay.service"),
  };
}

export function getPatchRelayConfigDir(): string {
  return getPatchRelayPathLayout().configDir;
}

export function getDefaultConfigPath(): string {
  return getPatchRelayPathLayout().configPath;
}

export function getDefaultEnvPath(): string {
  return getPatchRelayPathLayout().envPath;
}

export function getPatchRelayStateDir(): string {
  return getPatchRelayPathLayout().stateDir;
}

export function getPatchRelayDataDir(): string {
  return getPatchRelayPathLayout().shareDir;
}

export function getDefaultDatabasePath(): string {
  return getPatchRelayPathLayout().databasePath;
}

export function getDefaultLogPath(): string {
  return getPatchRelayPathLayout().logFilePath;
}

export function getDefaultWebhookArchiveDir(): string {
  return path.join(getPatchRelayStateDir(), "webhooks");
}

export function getSystemdUserUnitPath(): string {
  return getPatchRelayPathLayout().systemdUnitPath;
}

export function getPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function getBundledAssetPath(relativePath: string): string {
  return path.join(getPackageRoot(), relativePath);
}

export function readBundledAsset(relativePath: string): string {
  const assetPath = getBundledAssetPath(relativePath);
  if (!existsSync(assetPath)) {
    throw new Error(`Bundled asset not found: ${assetPath}`);
  }
  return readFileSync(assetPath, "utf8");
}

export function getBuiltCliEntryPath(): string {
  const entryPath = getBundledAssetPath("dist/index.js");
  if (!existsSync(entryPath)) {
    throw new Error(`Built PatchRelay entrypoint not found: ${entryPath}. Run npm run build before installing the service.`);
  }
  return entryPath;
}
