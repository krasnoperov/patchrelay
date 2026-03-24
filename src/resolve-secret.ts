import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a secret value using a three-level fallback:
 *
 * 1. `$CREDENTIALS_DIRECTORY/<credentialName>` — systemd-creds, Docker secrets,
 *    or any provider that mounts secrets as files in a private directory.
 * 2. `${envKey}_FILE` — reads the secret from an arbitrary file path.
 *    Works with any file-based provider (age, sops, mounted volumes).
 * 3. `$envKey` — direct environment variable (dev, `op run`, `sops exec-env`,
 *    or the legacy `service.env` EnvironmentFile).
 *
 * Returns `undefined` when the secret is not found at any level.
 */
export function resolveSecret(
  credentialName: string,
  envKey: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | undefined {
  // 1. systemd credentials directory (private mount, highest trust)
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  if (credDir) {
    try {
      return readFileSync(path.join(credDir, credentialName), "utf8").trim();
    } catch {
      // credential not in this directory — fall through
    }
  }

  // 2. _FILE convention (works with any file-based provider)
  const filePath = env[`${envKey}_FILE`];
  if (filePath) {
    try {
      return readFileSync(filePath, "utf8").trim();
    } catch {
      // file not readable — fall through
    }
  }

  // 3. Direct env var
  return env[envKey] || undefined;
}
