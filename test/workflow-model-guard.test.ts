import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const RETIRED_LIFECYCLE_TERMS = /factoryState|FactoryState|factory-state|legacy-issue-overview|pr-facts-derivation|sessionState|issue-session-state|session_state/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(filePath) : [filePath];
  });
}

test("source and architecture docs have one workflow model and cannot reintroduce the retired lifecycle", () => {
  const srcDir = path.resolve("src");
  const roots = [srcDir, path.resolve("docs")];
  const offenders = roots.flatMap(sourceFiles)
    .filter((filePath) => /\.(?:ts|tsx)$/.test(filePath))
    .concat(sourceFiles(path.resolve("docs")).filter((filePath) => filePath.endsWith(".md")))
    .filter((filePath) => filePath !== path.join(srcDir, "db", "migrations.ts"))
    .filter((filePath) => RETIRED_LIFECYCLE_TERMS.test(filePath) || RETIRED_LIFECYCLE_TERMS.test(readFileSync(filePath, "utf8")))
    .map((filePath) => path.relative(process.cwd(), filePath));

  assert.deepEqual(offenders, []);
});
