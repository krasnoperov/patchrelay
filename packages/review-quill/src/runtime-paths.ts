import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ReviewQuillPathLayout {
  homeDir: string;
  configDir: string;
  configPath: string;
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

export function getReviewQuillPathLayout(): ReviewQuillPathLayout {
  const homeDir = homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
  const xdgStateHome = process.env.XDG_STATE_HOME ?? path.join(homeDir, ".local", "state");
  const xdgDataHome = process.env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share");
  const configDir = ensureAbsolutePath(process.env.REVIEW_QUILL_CONFIG_DIR ?? path.join(xdgConfigHome, "review-quill"));
  const stateDir = ensureAbsolutePath(process.env.REVIEW_QUILL_STATE_DIR ?? path.join(xdgStateHome, "review-quill"));
  const dataDir = ensureAbsolutePath(process.env.REVIEW_QUILL_DATA_DIR ?? path.join(xdgDataHome, "review-quill"));
  const systemdDir = process.env.REVIEW_QUILL_SYSTEMD_DIR ?? "/etc/systemd/system";

  return {
    homeDir,
    configDir,
    configPath: path.join(configDir, "review-quill.json"),
    runtimeEnvPath: path.join(configDir, "runtime.env"),
    serviceEnvPath: path.join(configDir, "service.env"),
    stateDir,
    dataDir,
    systemdDir,
    systemdUnitPath: path.join(systemdDir, "review-quill.service"),
  };
}

export function getDefaultConfigPath(): string {
  return getReviewQuillPathLayout().configPath;
}

export function getDefaultRuntimeEnvPath(): string {
  return getReviewQuillPathLayout().runtimeEnvPath;
}

export function getDefaultServiceEnvPath(): string {
  return getReviewQuillPathLayout().serviceEnvPath;
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
