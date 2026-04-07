#!/usr/bin/env node

// Release planner for the direct-publish workflow.
//
// Strategy:
//   - Source of truth for "what's published": the npm registry (`npm view`).
//   - Marker for "commits since last release": the workflow's own `ci: release`
//     commit on main. Tags are optional/advisory.
//   - Manual override: if package.json version != published version, the
//     workflow publishes it as-is (contributor bumped version in their PR).
//   - Automatic bump: otherwise, aggregate conventional commits since the last
//     `ci: release` commit, filtered to files owned by the package.
//
// Outputs per package (root, steward, review_quill):
//   <key>_release — "true" if a version will be shipped this run
//   <key>_publish — "true" if we should run `npm publish` for it
//   <key>_version — the version string being shipped (or current if none)

import { execSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';

const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
if (!GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT not set');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function tryRun(cmd) {
  try { return run(cmd); } catch { return ''; }
}

function output(key, value) {
  appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`  ${key}=${value}`);
}

function readVersion(path) {
  return JSON.parse(readFileSync(path, 'utf8')).version;
}

const packages = [
  {
    key: 'root',
    npmName: 'patchrelay',
    tagPrefix: 'patchrelay-v',
    workspace: null,
    packageJson: 'package.json',
    matchFile: (f) => !f.startsWith('packages/'),
  },
  {
    key: 'steward',
    npmName: 'merge-steward',
    tagPrefix: 'merge-steward-v',
    workspace: 'packages/merge-steward',
    packageJson: 'packages/merge-steward/package.json',
    matchFile: (f) => f.startsWith('packages/merge-steward/'),
  },
  {
    key: 'review_quill',
    npmName: 'review-quill',
    tagPrefix: 'review-quill-v',
    workspace: 'packages/review-quill',
    packageJson: 'packages/review-quill/package.json',
    matchFile: (f) => f.startsWith('packages/review-quill/'),
  },
];

function publishedVersion(npmName) {
  return tryRun(`npm view ${npmName} version`); // empty string if not yet published
}

function lastReleaseCommit() {
  // Match our own `ci: release` marker and the legacy release-please
  // `chore: release` marker so the first run after the release-please
  // cutover boundaries on the last release-please commit.
  return tryRun(`git log --format=%H --grep='^ci: release' --grep='^chore: release' -n 1`);
}

function commitsSince(ref) {
  const range = ref ? `${ref}..HEAD` : 'HEAD';
  const log = tryRun(`git log ${range} --format=%H%x1f%s --no-merges`);
  if (!log) return [];
  return log.split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf('\x1f');
    return { hash: line.slice(0, i), subject: line.slice(i + 1) };
  });
}

function changedFiles(hash) {
  return tryRun(`git diff-tree --no-commit-id --name-only -r ${hash}`).split('\n').filter(Boolean);
}

function conventionalBump(subject) {
  if (/^[a-z]+(\([^)]*\))?!:/.test(subject)) return 'major';
  const m = subject.match(/^([a-z]+)(\([^)]*\))?:/);
  if (m?.[1] === 'feat') return 'minor';
  return 'patch';
}

const RANK = { patch: 1, minor: 2, major: 3 };
const higher = (a, b) => ((RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);

// Pre-1.0: breaking changes bump minor instead of major.
function applyPreMajor(bump, version) {
  return version.startsWith('0.') && bump === 'major' ? 'minor' : bump;
}

const marker = lastReleaseCommit();
console.log(`Last 'ci: release' commit: ${marker ? marker.slice(0, 8) : '(none — analyzing reachable history)'}`);

let anyRelease = false;

for (const pkg of packages) {
  console.log(`\n--- ${pkg.key} (${pkg.npmName}) ---`);

  const local = readVersion(pkg.packageJson);
  const published = publishedVersion(pkg.npmName);
  console.log(`Local: ${local}  Published: ${published || '(not on npm)'}`);

  // Manual override: contributor already bumped the version in their PR.
  if (published && local !== published) {
    console.log(`Manual bump detected (${published} → ${local}); will publish as-is.`);
    output(`${pkg.key}_release`, 'true');
    output(`${pkg.key}_publish`, 'true');
    output(`${pkg.key}_version`, local);
    anyRelease = true;
    continue;
  }

  // Automatic bump from conventional commits since the last release marker.
  const relevant = commitsSince(marker).filter((c) => {
    if (c.subject.startsWith('ci: release')) return false;
    return changedFiles(c.hash).some(pkg.matchFile);
  });

  console.log(`Relevant commits: ${relevant.length}`);

  if (relevant.length === 0) {
    if (!published) {
      console.log(`First publish of ${local}`);
      output(`${pkg.key}_release`, 'true');
      output(`${pkg.key}_publish`, 'true');
      output(`${pkg.key}_version`, local);
      anyRelease = true;
    } else {
      output(`${pkg.key}_release`, 'false');
      output(`${pkg.key}_publish`, 'false');
      output(`${pkg.key}_version`, local);
    }
    continue;
  }

  for (const c of relevant) console.log(`  ${c.hash.slice(0, 8)} ${c.subject}`);

  let bump = 'patch';
  for (const c of relevant) bump = higher(bump, conventionalBump(c.subject));
  bump = applyPreMajor(bump, local);
  console.log(`Bump: ${bump}`);

  const versionCmd = pkg.workspace
    ? `npm version ${bump} --no-git-tag-version -w ${pkg.workspace}`
    : `npm version ${bump} --no-git-tag-version`;
  run(versionCmd);

  const newVersion = readVersion(pkg.packageJson);
  console.log(`Version: ${local} → ${newVersion}`);

  output(`${pkg.key}_release`, 'true');
  output(`${pkg.key}_publish`, 'true');
  output(`${pkg.key}_version`, newVersion);
  anyRelease = true;
}

output('any_release', String(anyRelease));
