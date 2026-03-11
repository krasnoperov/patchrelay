import { chmod, open } from "node:fs/promises";

export const SERVICE_ENV_FILE_MODE = 0o600;
export const DATABASE_FILE_MODE = 0o600;
export const LOG_FILE_MODE = 0o640;

async function setMode(filePath: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  await chmod(filePath, mode);
}

async function enforceFileMode(filePath: string, mode: number, options?: { create?: boolean }): Promise<void> {
  if (options?.create) {
    const handle = await open(filePath, "a", mode);
    await handle.close();
  }

  try {
    await setMode(filePath, mode);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function enforceArbitraryFilePermissions(
  filePath: string,
  mode: number,
  options?: { create?: boolean },
): Promise<void> {
  await enforceFileMode(filePath, mode, options);
}

export async function enforceServiceEnvPermissions(serviceEnvPath: string): Promise<void> {
  await enforceFileMode(serviceEnvPath, SERVICE_ENV_FILE_MODE);
}

export async function enforceRuntimeFilePermissions(
  config: {
    database: { path: string };
    logging: { filePath: string };
  },
): Promise<void> {
  await enforceFileMode(config.database.path, DATABASE_FILE_MODE, { create: true });
  await enforceFileMode(config.logging.filePath, LOG_FILE_MODE, { create: true });
  await enforceFileMode(`${config.database.path}-wal`, DATABASE_FILE_MODE);
  await enforceFileMode(`${config.database.path}-shm`, DATABASE_FILE_MODE);
}
