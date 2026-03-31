import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MergeStewardPathLayout {
  homeDir: string;
  configDir: string;
  configPath: string;
  repoConfigDir: string;
  runtimeEnvPath: string;
  serviceEnvPath: string;
  stateDir: string;
  dataDir: string;
  systemdDir: string;
  systemdUnitPath: string;
}

function ensureAbsolutePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(value);
}

export function getMergeStewardPathLayout(): MergeStewardPathLayout {
  const homeDir = homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
  const xdgStateHome = process.env.XDG_STATE_HOME ?? path.join(homeDir, ".local", "state");
  const xdgDataHome = process.env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share");
  const configDir = ensureAbsolutePath(process.env.MERGE_STEWARD_CONFIG_DIR ?? path.join(xdgConfigHome, "merge-steward"));
  const stateDir = ensureAbsolutePath(process.env.MERGE_STEWARD_STATE_DIR ?? path.join(xdgStateHome, "merge-steward"));
  const dataDir = ensureAbsolutePath(process.env.MERGE_STEWARD_DATA_DIR ?? path.join(xdgDataHome, "merge-steward"));
  const systemdDir = process.env.MERGE_STEWARD_SYSTEMD_DIR ?? "/etc/systemd/system";

  return {
    homeDir,
    configDir,
    configPath: path.join(configDir, "merge-steward.json"),
    repoConfigDir: path.join(configDir, "repos"),
    runtimeEnvPath: path.join(configDir, "runtime.env"),
    serviceEnvPath: path.join(configDir, "service.env"),
    stateDir,
    dataDir,
    systemdDir,
    systemdUnitPath: path.join(systemdDir, "merge-steward.service"),
  };
}

export function getDefaultConfigPath(): string {
  return getMergeStewardPathLayout().configPath;
}

export function getDefaultRepoConfigDir(): string {
  return getMergeStewardPathLayout().repoConfigDir;
}

export function getDefaultRuntimeEnvPath(): string {
  return getMergeStewardPathLayout().runtimeEnvPath;
}

export function getDefaultServiceEnvPath(): string {
  return getMergeStewardPathLayout().serviceEnvPath;
}

export function getDefaultStateDir(): string {
  return getMergeStewardPathLayout().stateDir;
}

export function getDefaultDataDir(): string {
  return getMergeStewardPathLayout().dataDir;
}

export function getSystemdUnitPath(): string {
  return getMergeStewardPathLayout().systemdUnitPath;
}

export function getRepoConfigPath(repoId: string): string {
  return path.join(getDefaultRepoConfigDir(), `${repoId}.json`);
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
    throw new Error(`Built merge-steward entrypoint not found: ${entryPath}. Run npm run build -w merge-steward first.`);
  }
  return entryPath;
}
