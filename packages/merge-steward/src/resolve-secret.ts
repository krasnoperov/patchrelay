import { readFileSync } from "node:fs";
import path from "node:path";

export type SecretSource = "creddir" | "file" | "env" | "missing";

export interface ResolvedSecret {
  value: string | undefined;
  source: SecretSource;
}

export function resolveSecret(
  credentialName: string,
  envKey: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | undefined {
  return resolveSecretWithSource(credentialName, envKey, env).value;
}

export function resolveSecretWithSource(
  credentialName: string,
  envKey: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ResolvedSecret {
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  if (credDir) {
    try {
      const value = readFileSync(path.join(credDir, credentialName), "utf8").trim();
      if (value) return { value, source: "creddir" };
    } catch {
      // Fall through to the next source.
    }
  }

  const filePath = env[`${envKey}_FILE`];
  if (filePath) {
    try {
      const value = readFileSync(filePath, "utf8").trim();
      if (value) return { value, source: "file" };
    } catch {
      // Fall through to the next source.
    }
  }

  const value = env[envKey] || undefined;
  if (value) return { value, source: "env" };

  return { value: undefined, source: "missing" };
}
