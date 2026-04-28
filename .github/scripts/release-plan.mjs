#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { PACKAGE_SPECS, planPackageRelease, versionCommandArgs } from "./release-plan-lib.mjs";

const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
if (!GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT not set");

function run(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function runFile(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function tryRun(cmd) {
  try {
    return run(cmd);
  } catch {
    return "";
  }
}

function output(key, value) {
  appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`  ${key}=${value}`);
}

function readVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

function publishedVersion(npmName) {
  return tryRun(`npm view ${npmName} version`);
}

function lastReleaseCommit() {
  return tryRun(`git log --format=%H --grep='^ci: release$' --grep='^chore: release' -n 1`);
}

function commitsSince(ref) {
  const range = ref ? `${ref}..HEAD` : "HEAD";
  const log = tryRun(`git log ${range} --format=%H%x1f%s --no-merges`);
  if (!log) return [];
  return log.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("\x1f");
    return {
      hash: line.slice(0, separator),
      subject: line.slice(separator + 1),
    };
  });
}

function changedFiles(hash) {
  return tryRun(`git diff-tree --no-commit-id --name-only -r ${hash}`).split("\n").filter(Boolean);
}

function applyVersion(pkg, targetVersion) {
  const currentVersion = readVersion(pkg.packageJson);
  if (currentVersion === targetVersion) return;
  const [command, args] = versionCommandArgs(pkg, targetVersion);
  runFile(command, args);
}

const marker = lastReleaseCommit();
console.log(`Last release marker: ${marker ? marker.slice(0, 8) : "(none — analyzing reachable history)"}`);

let anyRelease = false;

for (const pkg of PACKAGE_SPECS) {
  console.log(`\n--- ${pkg.key} (${pkg.npmName}) ---`);

  const localVersion = readVersion(pkg.packageJson);
  const published = publishedVersion(pkg.npmName);
  console.log(`Local: ${localVersion}  Published: ${published || "(not on npm)"}`);

  const relevantCommits = commitsSince(marker).filter((commit) => {
    if (commit.subject.startsWith("ci: release")) return false;
    return changedFiles(commit.hash).some((file) => pkg.ownsFile(file));
  });
  for (const commit of relevantCommits) {
    console.log(`  ${commit.hash.slice(0, 8)} ${commit.subject}`);
  }

  const plan = planPackageRelease({
    localVersion,
    publishedVersion: published,
    relevantSubjects: relevantCommits.map((commit) => commit.subject),
  });
  console.log(`Plan: ${plan.reason}`);

  if (plan.reason === "published_version_ahead_of_repo") {
    throw new Error(
      `${pkg.npmName} is behind npm (${localVersion} < ${published}). Refusing to guess a recovery. `
      + "Bump the repo version to the published one or publish a newer version from the repo state.",
    );
  }

  applyVersion(pkg, plan.nextVersion);

  output(`${pkg.key}_release`, String(plan.release));
  output(`${pkg.key}_publish`, String(plan.publish));
  output(`${pkg.key}_version`, plan.nextVersion);

  if (plan.release) {
    anyRelease = true;
  }
}

output("any_release", String(anyRelease));
