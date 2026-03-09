import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ZmxSessionManager } from "../src/zmx.js";

const sanitizedAttachEnv = { ...process.env };
delete sanitizedAttachEnv.ZMX_SESSION;
delete sanitizedAttachEnv.ZMX_SESSION_PREFIX;

async function waitForSession(
  zmx: ZmxSessionManager,
  listedSessionName: string,
  present: boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const sessions = await zmx.listSessions({ env: sanitizedAttachEnv, timeoutMs: 5_000 });
    const exists = sessions.includes(listedSessionName);
    if (exists === present) {
      return;
    }
    await delay(250);
  }

  const sessions = await zmx.listSessions({ env: sanitizedAttachEnv, timeoutMs: 5_000 });
  assert.equal(
    sessions.includes(listedSessionName),
    present,
    `expected session ${listedSessionName} presence to be ${present}, got ${JSON.stringify(sessions)}`,
  );
}

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
    const launchElapsedMs = Date.now() - startedAt;

    const waitResult = await zmx.wait(sessionName, {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(waitResult.exitCode, 0, `expected zmx wait to exit 0, got ${waitResult.exitCode}`);
    assert.ok(launchElapsedMs < 5_000, `expected zmx run to return quickly, got ${launchElapsedMs}ms`);
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

test(
  "zmx attach creates a listable interactive session",
  {
    timeout: 30_000,
  },
  async () => {
    const zmx = new ZmxSessionManager("zmx");
    const sessionName = `patchrelay-attach-${randomUUID()}`;
    const listedSessionName = sessionName;
    const child = zmx.attachCommandLine(sessionName, "printf 'attach-path-ok\\n'; exec bash", {
      cwd: process.cwd(),
      env: sanitizedAttachEnv,
    });

    try {
      await waitForSession(zmx, listedSessionName, true, 10_000);

      child.write("exit\n");

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for zmx attach PTY to exit")), 10_000);
        child.onExit(({ exitCode: code }) => resolve(code));
        child.onData(() => {
          // Keep a consumer attached so node-pty drains output.
        });
        child.onExit(() => {
          clearTimeout(timeout);
        });
      });

      assert.equal(exitCode, 0, `expected zmx attach to exit 0, got ${exitCode}`);
      await waitForSession(zmx, listedSessionName, false, 10_000);
    } finally {
      child.kill();
      try {
        await zmx.kill(sessionName, { timeoutMs: 10_000 });
      } catch {
        // Ignore cleanup failures if the session is already gone.
      }
    }
  },
);

test(
  "zmx run under a PTY creates a listable session and preserves completed session history",
  {
    timeout: 30_000,
  },
  async () => {
    const zmx = new ZmxSessionManager("zmx");
    const sessionName = `patchrelay-run-pty-${randomUUID()}`;
    const marker = `RUN_PTY_${randomUUID()}`;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "patchrelay-zmx-run-pty-"));
    const markerFile = path.join(tempDir, "marker.txt");

    const child = pty.spawn("zmx", ["run", sessionName, `sleep 5; printf '${marker}\\n' > '${markerFile}'`], {
      name: "xterm-256color",
      cwd: process.cwd(),
      env: sanitizedAttachEnv,
      cols: 120,
      rows: 40,
    });

    try {
      child.onData(() => {
        // Keep a consumer attached so node-pty drains output.
      });

      const launchExitCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for zmx run PTY to exit")), 10_000);
        child.onExit(({ exitCode }) => {
          clearTimeout(timeout);
          resolve(exitCode);
        });
      });

      assert.equal(launchExitCode, 0, `expected zmx run PTY to exit 0, got ${launchExitCode}`);

      await waitForSession(zmx, sessionName, true, 10_000);

      await delay(5_500);

      const fileContents = await readFile(markerFile, "utf8");
      assert.match(fileContents, new RegExp(marker), "zmx run PTY session should create the expected marker file");
      await waitForSession(zmx, sessionName, true, 10_000);

      const history = await zmx.history(sessionName, { env: sanitizedAttachEnv, timeoutMs: 10_000 });
      assert.match(history, /ZMX_TASK_COMPLETED:0/, "completed PTY run should be preserved in session history");
    } finally {
      child.kill();
      try {
        await zmx.kill(sessionName, { timeoutMs: 10_000 });
      } catch {
        // Ignore cleanup failures if the session is already gone.
      }
    }
  },
);
