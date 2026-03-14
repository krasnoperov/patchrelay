# Shipping PatchRelay

## Purpose

This is the operator runbook for shipping a PatchRelay change from a local checkout to the live
service installed from npm.

Use this guide when the work is already implemented and green locally, and you now need to:

1. merge the change through the repo's release flow
2. wait for the published npm version
3. install that exact published version on the live machine
4. restart the PatchRelay user service
5. verify the live service is actually running the expected build

This is intentionally separate from the general self-hosting guide. Self-hosting explains how to
install PatchRelay. This doc explains how to ship an update safely.

## Shipping Model

PatchRelay ships in two distinct steps:

1. repository release
2. machine upgrade

Those steps are related, but they are not the same thing.

Repository release means:

- work lands on `main`
- Release Please opens or updates the release PR
- the release PR is merged
- GitHub Actions publishes the package to npm

Machine upgrade means:

- the target machine installs the published npm package version explicitly
- the systemd user service is restarted
- the running service is verified against the expected release

Do not treat "merged to main" as "live." PatchRelay is only live on a machine after that machine
installs the published package and restarts the service.

## Preconditions

Before shipping:

- work is on a short-lived branch, not `main`
- the change has a releasable Conventional Commit title
- `npm run ci` passes locally
- you understand whether the change should be a patch or minor bump
- you know which machine or machines need the upgrade

In this repo:

- `fix:` produces the next patch release while still in `0.x`
- `feat:` produces the next minor release while still in `0.x`
- `chore:` alone is not releasable

The current release version is tracked in:

- [package.json](../package.json)
- [.release-please-manifest.json](../.release-please-manifest.json)

## Release Flow

### 1. Prepare the branch

Start from the current `main` tip:

```bash
git fetch origin
git switch -c fix/short-description origin/main
```

Make the change, then run:

```bash
npm run ci
```

Commit with a releasable Conventional Commit message:

```bash
git commit -am "fix: recover interrupted codex runs after restart"
```

Push the branch and open a PR.

### 2. Merge to `main`

Use the normal PR flow.

Preferred merge mode:

- squash merge

Important:

- the final merge title must still be releasable
- do not manually work on the Release Please branch

### 3. Wait for Release Please

After the releasable commit lands on `main`, Release Please runs from:

- [.github/workflows/release.yml](../.github/workflows/release.yml)

Expected behavior:

1. Release Please opens or updates a release PR.
2. That release PR bumps the version and changelog.
3. Once the release PR is merged, the workflow checks out the release tag and runs:
   - `npm ci`
   - `npm run ci`
   - `npm publish --access public`

If no release PR appears:

- check for stale release PRs
- check labels such as `autorelease: pending` or `autorelease: triggered`
- rerun the Release Please workflow if needed

### 4. Confirm the published npm version

Do not upgrade the live machine until the exact version is available from npm.

Check the published version:

```bash
npm view patchrelay version
```

If you need a specific version:

```bash
npm view patchrelay versions --json
```

Wait until the expected version is visible there before upgrading the live install.

## Machine Upgrade

### 5. Install the exact published version

On the target machine, install the published version explicitly:

```bash
npm install -g patchrelay@<published-version>
```

Use the exact version you just confirmed from npm. Avoid `latest` when you are verifying a specific
fix rollout.

Examples:

```bash
npm install -g patchrelay@0.7.3
npm install -g patchrelay@0.8.0
```

### 6. Restart the service

After the package upgrade, restart PatchRelay through the CLI:

```bash
patchrelay restart-service
```

This reloads the systemd user units and reload-or-restarts `patchrelay.service`.

If needed, the equivalent lower-level commands are:

```bash
systemctl --user daemon-reload
systemctl --user reload-or-restart patchrelay.service
```

## Verification

After restart, verify the live machine rather than assuming the upgrade worked.

### 7. Confirm the installed CLI version

```bash
patchrelay version
```

That should match the version you installed from npm.

### 8. Confirm the service is healthy

```bash
patchrelay doctor
systemctl --user status patchrelay --no-pager
```

### 9. Confirm the running logs look healthy

```bash
journalctl --user -u patchrelay.service -n 100 --no-pager
tail -n 100 ~/.local/state/patchrelay/patchrelay.log
```

Look for:

- the service starting normally
- Codex app-server connecting successfully
- no immediate startup reconciliation failures

### 10. Verify the shipped behavior

For a change with behavioral risk, run a manual drill that exercises the feature you shipped.

For example, for restart recovery work:

1. start a real issue stage
2. restart PatchRelay mid-turn
3. confirm the issue remains in the active workflow state instead of falling back to `Human Needed`
4. confirm the run continues on the existing thread/worktree

For high-risk changes, test both:

- graceful restart
- abrupt stop and restart

## Rollback

If the new version is bad, roll back by installing the previous published version explicitly:

```bash
npm install -g patchrelay@<previous-version>
patchrelay restart-service
```

Then verify again with:

```bash
patchrelay version
systemctl --user status patchrelay --no-pager
```

## Release Checklist

Use this as the short operator checklist:

1. `npm run ci`
2. merge releasable PR to `main`
3. wait for Release Please PR
4. merge the release PR
5. confirm `npm view patchrelay version`
6. `npm install -g patchrelay@<published-version>`
7. `patchrelay restart-service`
8. `patchrelay version`
9. `patchrelay doctor`
10. verify the shipped behavior on the live service
