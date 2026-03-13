import assert from "node:assert/strict";
import { chdir } from "node:process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getBuildInfo } from "../src/build-info.ts";

test("getBuildInfo prefers bundled build metadata over the current working directory", () => {
  const originalCwd = process.cwd();
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-build-info-"));
  const distDir = path.join(baseDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    path.join(distDir, "build-info.json"),
    `${JSON.stringify({
      service: "patchrelay",
      version: "9.9.9",
      commit: "fake",
      builtAt: "fake",
    })}\n`,
    "utf8",
  );

  const bundled = getBuildInfo();

  try {
    chdir(baseDir);
    assert.deepEqual(getBuildInfo(), bundled);
  } finally {
    chdir(originalCwd);
    rmSync(baseDir, { recursive: true, force: true });
  }
});
