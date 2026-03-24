import { readFileSync } from "node:fs";
import path from "node:path";

export type SecretSource = "creddir" | "file" | "env" | "missing";

export interface ResolvedSecret {
  value: string | undefined;
  source: SecretSource;
}

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
  return resolveSecretWithSource(credentialName, envKey, env).value;
}

/**
 * Same as `resolveSecret` but also returns which layer provided the value.
 */
export function resolveSecretWithSource(
  credentialName: string,
  envKey: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ResolvedSecret {
  // 1. systemd credentials directory (private mount, highest trust)
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  if (credDir) {
    try {
      const value = readFileSync(path.join(credDir, credentialName), "utf8").trim();
      if (value) return { value, source: "creddir" };
    } catch {
      // credential not in this directory — fall through
    }
  }

  // 2. _FILE convention (works with any file-based provider)
  const filePath = env[`${envKey}_FILE`];
  if (filePath) {
    try {
      const value = readFileSync(filePath, "utf8").trim();
      if (value) return { value, source: "file" };
    } catch {
      // file not readable — fall through
    }
  }

  // 3. Direct env var
  const value = env[envKey] || undefined;
  if (value) return { value, source: "env" };

  return { value: undefined, source: "missing" };
}
