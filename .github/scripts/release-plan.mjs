#!/usr/bin/env node

// Analyzes conventional commits since each package's last git tag,
// determines version bump, applies via `npm version`, outputs plan
// to $GITHUB_OUTPUT for the release workflow.

import { execSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';

const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
if (!GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT not set');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
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

function latestTag(prefix) {
  try {
    const out = run(`git tag --sort=-v:refname --list '${prefix}*'`);
    return out.split('\n')[0] || '';
  } catch {
    return '';
  }
}

function commitsSince(ref) {
  const range = ref ? `${ref}..HEAD` : 'HEAD';
  let log;
  try {
    log = run(`git log ${range} --format=%H%x1f%s --no-merges`);
  } catch {
    return [];
  }
  if (!log) return [];
  return log.split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf('\x1f');
    return { hash: line.slice(0, i), subject: line.slice(i + 1) };
  });
}

function changedFiles(hash) {
  try {
    return run(`git diff-tree --no-commit-id --name-only -r ${hash}`).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function conventionalBump(subject) {
  if (/^[a-z]+(\([^)]*\))?!:/.test(subject)) return 'major';
  const m = subject.match(/^([a-z]+)(\([^)]*\))?:/);
  if (m?.[1] === 'feat') return 'minor';
  return 'patch';
}

const RANK = { patch: 1, minor: 2, major: 3 };
const higher = (a, b) => ((RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);

// Pre-1.0: breaking changes bump minor instead of major
function applyPreMajor(bump, version) {
  return version.startsWith('0.') && bump === 'major' ? 'minor' : bump;
}

function npmHas(name, version) {
  try {
    run(`npm view ${name}@${version} version`);
    return true;
  } catch {
    return false;
  }
}

let anyRelease = false;

for (const pkg of packages) {
  console.log(`\n--- ${pkg.key} (${pkg.npmName}) ---`);

  const tag = latestTag(pkg.tagPrefix);
  console.log(`Latest tag: ${tag || '(none)'}`);

  const all = commitsSince(tag);
  const relevant = all.filter((c) => {
    if (c.subject.startsWith('ci: release')) return false;
    return changedFiles(c.hash).some(pkg.matchFile);
  });

  console.log(`Commits: ${all.length} total, ${relevant.length} relevant`);

  if (relevant.length === 0) {
    output(`${pkg.key}_release`, 'false');
    output(`${pkg.key}_publish`, 'false');
    output(`${pkg.key}_version`, readVersion(pkg.packageJson));
    continue;
  }

  for (const c of relevant) console.log(`  ${c.hash.slice(0, 8)} ${c.subject}`);

  let bump = 'patch';
  for (const c of relevant) bump = higher(bump, conventionalBump(c.subject));
  bump = applyPreMajor(bump, readVersion(pkg.packageJson));
  console.log(`Bump: ${bump}`);

  const versionCmd = pkg.workspace
    ? `npm version ${bump} --no-git-tag-version -w ${pkg.workspace}`
    : `npm version ${bump} --no-git-tag-version`;
  run(versionCmd);

  const newVersion = readVersion(pkg.packageJson);
  console.log(`Version: ${newVersion}`);

  const onNpm = npmHas(pkg.npmName, newVersion);
  if (onNpm) console.log(`Already on npm — will tag but skip publish`);

  output(`${pkg.key}_release`, 'true');
  output(`${pkg.key}_publish`, String(!onNpm));
  output(`${pkg.key}_version`, newVersion);
  anyRelease = true;
}

output('any_release', String(anyRelease));
