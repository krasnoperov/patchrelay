import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZmxSessionManager } from "../src/zmx.js";

test("zmx runs a named session, waits for completion, and executes the queued command", async () => {
  const zmx = new ZmxSessionManager("zmx");
  const sessionName = `patchrelay-test-${randomUUID()}`;
  const marker = `PATCHRELAY_TEST_${randomUUID()}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "patchrelay-zmx-"));
  const markerFile = path.join(tempDir, "marker.txt");

  try {
    const startedAt = Date.now();
    await zmx.runCommandLine(sessionName, `sleep 10; printf '${marker}\\n' > '${markerFile}'`, {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });

    const waitResult = await zmx.wait(sessionName, {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(waitResult.exitCode, 0, `expected zmx wait to exit 0, got ${waitResult.exitCode}`);
    assert.ok(elapsedMs >= 9_000, `expected wait to take at least 9s, got ${elapsedMs}ms`);

    const fileContents = await readFile(markerFile, "utf8");
    assert.match(fileContents, new RegExp(marker), "session command should create the expected marker file");
  } finally {
    try {
      await zmx.kill(sessionName, { timeoutMs: 10_000 });
    } catch {
      // Ignore cleanup failures if the session is already gone.
    }
  }
}, 40_000);
