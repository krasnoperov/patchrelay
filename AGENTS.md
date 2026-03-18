# PatchRelay Agent Notes

PatchRelay is a harness around Codex and Linear. Keep changes aligned with the current harness
boundaries and avoid pulling repo-specific workflow policy into the service core.

Use these docs selectively:

- Read [docs/module-map.md](./docs/module-map.md) before making structural or cross-module changes.
- Read [docs/state-authority.md](./docs/state-authority.md) before changing persistence, reconciliation, or ownership logic.
- Read [docs/persistence-audit.md](./docs/persistence-audit.md) when adding or removing stored fields, changing DB tables, or reclassifying data as authoritative versus derived.
- Read [docs/shipping.md](./docs/shipping.md) when the task is to release PatchRelay, publish it to npm, or upgrade a live PatchRelay install.

Working guidance:

- Keep SQLite focused on harness coordination and restart-safe ownership state.
- Treat raw event history, reports, and operator-facing views as derived unless a change truly needs them for correctness.
- Prefer small boundary-tightening changes over broad refactors.

Execution defaults:

- When user intent is clear and the next step is the obvious, lowest-risk, policy-compliant continuation, do it without asking.
- Ask only when there are multiple materially different outcomes, meaningful risk of data loss, or hidden consequences the user may reasonably want to choose between.
- Prefer the shortest compliant path that preserves a clean repo state and avoids temporary local-only states.
- If platform or repo rules block the direct path, switch to the nearest compliant path instead of stopping for a confirmation that does not change the outcome.
- Do not split one obvious task into multiple permission checkpoints.

Release workflow guidance:

- Do all development on a short-lived branch. Do not commit directly on `main`.
- Start new work from the current `main` tip into a topic branch such as `fix/...`, `feat/...`, or `chore/...`.
- Merge completed work back through a branch/PR flow so Release Please can see a clean releasable history on `main`.
- Do not locally merge a topic branch into `main` before the PR merge. Keep local `main` aligned with `origin/main`, merge through GitHub, then fast-forward local `main` afterward.
- For docs-only or other non-functional changes, prefer the shortest path: branch, commit, push, open PR, merge PR, sync local `main`.
- Run `npm run ci` before merging a PR when the change touches code, tests, build tooling, workflows, or runtime behavior. Docs-only changes may skip the local `npm run ci` run unless explicitly requested.
- CI should run for branch pushes, pull requests, and pushes to `main` so failures surface before and after merge.
- Prefer squash merges for releasable work. Release Please documents squash merge as the recommended mode for commit-message overrides and clean release parsing.
- Make the squash commit or final merge-to-`main` commit use a Conventional Commit title. In this repo, `feat:` triggers the next minor release and `fix:` triggers the next patch release while still in `0.x`. `deps:` is also releasable; `chore:` alone is not.
- Assume `main` branch protection is authoritative. Do not attempt direct pushes to `main`; open a PR and use `gh pr merge --squash --delete-branch` once checks are satisfied.
- If the user asks to merge and `main` is protected, default to: push branch, open PR, squash merge, sync local `main`.
- Release Please in this repo runs from `.github/workflows/release.yml` on pushes to `main`, using `release-please-config.json` and `.release-please-manifest.json`. A release PR is only opened or updated after releasable commits land on `main`.
- `main` is protected by required GitHub checks. Keep the workflow job names `lint`, `typecheck`, and `test` stable unless you are also updating the branch protection/ruleset to match.
- CI and Release Please run on GitHub-hosted runners for this repo. Keep workflow `runs-on` labels aligned with GitHub-hosted images unless a trusted workflow has a specific need for self-hosted infrastructure.
- Do not develop on or manually repurpose the `release-please--branches--main--components--patchrelay` branch. That branch is owned by Release Please.
- If a release PR does not appear after releasable work lands on `main`, check for stale PRs or labels such as `autorelease: pending` / `autorelease: triggered`, then rerun the Release Please workflow.
