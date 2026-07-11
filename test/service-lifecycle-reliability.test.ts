import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGracefulShutdown as createPatchRelayShutdown } from "../src/graceful-shutdown.ts";
import { createGracefulShutdown as createReviewQuillShutdown } from "../packages/review-quill/src/graceful-shutdown.ts";
import { createGracefulShutdown as createMergeStewardShutdown } from "../packages/merge-steward/src/graceful-shutdown.ts";
import { handleStdoutError } from "../packages/review-quill/src/stdout-error.ts";

type ShutdownFactory = typeof createPatchRelayShutdown;

function createLogCapture() {
  const entries: Array<{ level: string; bindings: Record<string, unknown>; message: string }> = [];
  return {
    entries,
    logger: {
      info(bindings: Record<string, unknown>, message: string) {
        entries.push({ level: "info", bindings, message });
      },
      warn(bindings: Record<string, unknown>, message: string) {
        entries.push({ level: "warn", bindings, message });
      },
      error(bindings: Record<string, unknown>, message: string) {
        entries.push({ level: "error", bindings, message });
      },
    },
  };
}

for (const [service, factory] of [
  ["patchrelay", createPatchRelayShutdown],
  ["review-quill", createReviewQuillShutdown],
  ["merge-steward", createMergeStewardShutdown],
] as const satisfies ReadonlyArray<readonly [string, ShutdownFactory]>) {
  test(`${service} shutdown is observable and idempotent`, async () => {
    const logs = createLogCapture();
    let cleanupCount = 0;
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const shutdown = factory({
      service,
      logger: logs.logger,
      cleanup: async () => {
        cleanupCount += 1;
        await cleanupGate;
      },
    });

    const first = shutdown("SIGTERM");
    const duplicate = shutdown("SIGINT");
    assert.strictEqual(first, duplicate);
    assert.equal(cleanupCount, 1);
    releaseCleanup();
    await first;

    assert.deepEqual(
      logs.entries.map((entry) => [entry.level, entry.message, entry.bindings.trigger]),
      [
        ["info", "Shutdown requested", "SIGTERM"],
        ["warn", "Shutdown already in progress", "SIGINT"],
        ["info", "Shutdown complete", "SIGTERM"],
      ],
    );
  });

  test(`${service} shutdown failure is logged and produces a failing exit code`, async () => {
    const logs = createLogCapture();
    const exitCodes: number[] = [];
    const shutdown = factory({
      service,
      logger: logs.logger,
      cleanup: async () => {
        throw new Error("cleanup failed");
      },
      terminate: (code) => {
        exitCodes.push(code);
      },
    });

    await shutdown("SIGTERM");
    assert.deepEqual(exitCodes, [1]);
    assert.deepEqual(logs.entries.at(-1), {
      level: "error",
      bindings: { service, trigger: "SIGTERM", error: "cleanup failed" },
      message: "Shutdown failed",
    });
  });
}

test("all canonical daemon units recover from unexpected clean exits", () => {
  for (const unitPath of [
    "infra/patchrelay.service",
    "packages/review-quill/infra/review-quill.service",
    "packages/merge-steward/infra/merge-steward.service",
  ]) {
    const unit = readFileSync(unitPath, "utf8");
    assert.match(unit, /^Restart=always$/m, unitPath);
    assert.doesNotMatch(unit, /^Restart=on-failure$/m, unitPath);
    assert.match(unit, /^RestartSec=5$/m, unitPath);
  }
});

test("review-quill keeps EPIPE success handling out of server mode", () => {
  const calls: Array<["exit" | "stderr", number | string]> = [];
  const actions = {
    exit(code: number): never {
      calls.push(["exit", code]);
      throw new Error(`exit:${code}`);
    },
    writeStderr(message: string) {
      calls.push(["stderr", message]);
    },
  };
  const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });

  assert.throws(() => handleStdoutError(epipe, "status", actions), /exit:0/);
  assert.deepEqual(calls, [["exit", 0]]);

  calls.length = 0;
  assert.throws(() => handleStdoutError(epipe, "serve", actions), /exit:1/);
  assert.match(String(calls[0]?.[1]), /serve lost its stdout stream \(EPIPE\)/);
  assert.deepEqual(calls.at(-1), ["exit", 1]);
});
