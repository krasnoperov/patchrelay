---
name: release-deploy
description: "Run the PatchRelay stack’s branch-to-main release workflow: commit on a feature branch, get PR CI green, merge to main without squash, wait for main CI, install newly published npm package versions, restart services, and verify runtime health. Use when the user wants one commandable workflow for shipping PatchRelay, merge-steward, and review-quill changes."
---

# PatchRelay Release Deploy

## Overview

Use this skill when the user wants to ship this repo safely end to end instead of handling git, CI, npm installs, and service restarts as separate ad hoc steps.

Canonical invocation:

`Use $release-deploy to ship this repo.`

## Workflow

### 1. Work On A Branch

1. Never work directly on `main`.
2. Make commits on a branch with conventional commit subjects when the change should affect version bumps.
3. Never squash-merge; this repo uses non-merge commit subjects for release planning.
4. Before pushing, run the repo checks that match the touched surface.

Default repo-wide validation:

```bash
pnpm ci
```

Targeted checks are acceptable while iterating, but do not ship without confidence that the touched package(s) are green.

### 2. Push And Get PR CI Green

1. Push the branch and open/update the PR.
2. Wait until the PR’s required CI is green.
3. If review or requested-changes work is involved, make sure any fix pushes a new head before considering the PR ready again.

Preferred git behavior:

```bash
git push -u origin <branch>
gh pr checks
```

### 3. Merge To Main

1. Merge only after PR CI is green.
2. Use a regular merge, not squash.
3. After merge, wait for `main` CI to pass again before installing or restarting services.

Examples:

```bash
gh pr merge --merge
gh pr checks --watch
```

If `gh pr checks` is PR-focused rather than `main`-focused, explicitly inspect the latest `main` branch run before continuing. A reliable CLI sequence is:

```bash
gh run list --branch main --workflow Release --limit 1
gh run watch <run-id>
```

### 4. Install Published Package Versions

After `main` is green, install the newly published npm package versions on the machine that runs the services.

Typical packages in this repo:

```bash
npm install -g patchrelay@latest
npm install -g merge-steward@latest
npm install -g review-quill@latest
```

Before installing, verify npm has the expected version(s) from the merged `main` commit:

```bash
npm view patchrelay version
npm view merge-steward version
npm view review-quill version
```

If the user wants a selective rollout, install only the package(s) affected by the merged change. If npm publication has not happened yet, or the registry still reports the pre-merge version, stop and say so instead of deploying stale versions.

### 5. Restart Services

Restart the services after installing the new packages:

```bash
patchrelay service restart
merge-steward service restart
review-quill service restart
```

### 6. Verify Runtime Health

Verify that the installed binaries and live services match the expected rollout. If the merged change did not publish any package, say that explicitly and skip install/restart rather than pretending a deploy happened:

```bash
patchrelay --version
merge-steward --version
review-quill --version
patchrelay service status
merge-steward service status
review-quill service status
```

If anything looks wrong, inspect logs immediately:

```bash
patchrelay service logs --lines 100
merge-steward service logs --lines 100
review-quill service logs --lines 100
```

## Decision Rules

- If the user asks to “ship”, “release”, “deploy”, or “roll out” this repo, use this workflow.
- If the user wants local-only testing or branch-only work, do not force the deploy steps.
- If `main` CI is red, do not install or restart services.
- If the merged commit has not been published to npm yet, do not install `@latest` and pretend the deploy is complete.
- If only one package changed, prefer a minimal install/restart set, but keep verification explicit.

## Definition Of Done

- Branch commits are pushed and PR CI is green.
- The PR is merged with `--merge`, not squash.
- `main` CI is green after merge.
- The intended npm package versions are confirmed on npm before installation.
- The intended npm package versions are installed on the target machine when a package release occurred.
- Services have been restarted when a package release occurred.
- Service status and version checks confirm the rollout, or the workflow clearly reports that no deployable package changed.
