import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  DATABASE_FILE_MODE,
  LOG_FILE_MODE,
  SERVICE_ENV_FILE_MODE,
  enforceRuntimeFilePermissions,
  enforceServiceEnvPermissions,
} from "../src/file-permissions.ts";

function modeOf(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

const supportsPosixModes = process.platform !== "win32";

test("service env permissions are enforced for existing files", async (t) => {
  if (!supportsPosixModes) {
    t.skip("POSIX file modes are not enforced on Windows");
    return;
  }

  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-permissions-service-env-"));
  const envPath = path.join(baseDir, "service.env");

  try {
    writeFileSync(envPath, "LINEAR_WEBHOOK_SECRET=secret\n", { mode: 0o644 });

    await enforceServiceEnvPermissions(envPath);

    assert.equal(modeOf(envPath), SERVICE_ENV_FILE_MODE);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runtime file permissions create and tighten db and log files", async (t) => {
  if (!supportsPosixModes) {
    t.skip("POSIX file modes are not enforced on Windows");
    return;
  }

  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-permissions-runtime-"));
  const dbPath = path.join(baseDir, "patchrelay.sqlite");
  const logPath = path.join(baseDir, "patchrelay.log");

  try {
    writeFileSync(dbPath, "", { mode: 0o666 });
    writeFileSync(logPath, "", { mode: 0o666 });
    writeFileSync(`${dbPath}-wal`, "", { mode: 0o666 });
    writeFileSync(`${dbPath}-shm`, "", { mode: 0o666 });

    await enforceRuntimeFilePermissions({
      database: {
        path: dbPath,
      },
      logging: {
        filePath: logPath,
      },
    });

    assert.equal(modeOf(dbPath), DATABASE_FILE_MODE);
    assert.equal(modeOf(logPath), LOG_FILE_MODE);
    assert.equal(modeOf(`${dbPath}-wal`), DATABASE_FILE_MODE);
    assert.equal(modeOf(`${dbPath}-shm`), DATABASE_FILE_MODE);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
