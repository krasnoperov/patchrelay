import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getBuildInfo } from "../src/build-info.ts";

test("getBuildInfo prefers bundled build metadata over the current working directory", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-build-info-"));
  const cwdDistDir = path.join(baseDir, "cwd-dist");
  const bundledDistDir = path.join(baseDir, "bundled-dist");
  mkdirSync(cwdDistDir, { recursive: true });
  mkdirSync(bundledDistDir, { recursive: true });
  writeFileSync(
    path.join(cwdDistDir, "build-info.json"),
    `${JSON.stringify({
      service: "patchrelay",
      version: "9.9.9",
      commit: "fake",
      builtAt: "fake",
    })}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(bundledDistDir, "build-info.json"),
    `${JSON.stringify({
      service: "patchrelay",
      version: "0.6.0",
      commit: "bundled",
      builtAt: "bundled",
    })}\n`,
    "utf8",
  );

  try {
    assert.deepEqual(
      getBuildInfo({
        bundledPath: path.join(bundledDistDir, "build-info.json"),
        cwdPath: path.join(cwdDistDir, "build-info.json"),
      }),
      {
        service: "patchrelay",
        version: "0.6.0",
        commit: "bundled",
        builtAt: "bundled",
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
