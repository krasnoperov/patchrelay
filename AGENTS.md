# PatchRelay Agent Notes

PatchRelay is a harness around Codex and Linear. Keep changes aligned with the current harness
boundaries and avoid pulling repo-specific workflow policy into the service core.

Use these docs selectively:

- Read [docs/module-map.md](./docs/module-map.md) before making structural or cross-module changes.
- Read [docs/state-authority.md](./docs/state-authority.md) before changing persistence, reconciliation, or ownership logic.
- Read [docs/persistence-audit.md](./docs/persistence-audit.md) when adding or removing stored fields, changing DB tables, or reclassifying data as authoritative versus derived.

Working guidance:

- Keep SQLite focused on harness coordination and restart-safe ownership state.
- Treat raw event history, reports, and operator-facing views as derived unless a change truly needs them for correctness.
- Prefer small boundary-tightening changes over broad refactors.

Release workflow guidance:

- Do all development on a short-lived branch. Do not commit directly on `main`.
- Start new work from the current `main` tip into a topic branch such as `fix/...`, `feat/...`, or `chore/...`.
- Merge completed work back through a branch/PR flow so Release Please can see a clean releasable history on `main`.
- Run `npm run ci` before opening or merging a PR. In this repo that is the local pre-merge gate for lint, typecheck, tests, and build.
- Prefer squash merges for releasable work. Release Please documents squash merge as the recommended mode for commit-message overrides and clean release parsing.
- Make the squash commit or final merge-to-`main` commit use a Conventional Commit title. In this repo, `feat:` triggers the next minor release and `fix:` triggers the next patch release while still in `0.x`. `deps:` is also releasable; `chore:` alone is not.
- Release Please in this repo runs from `.github/workflows/release.yml` on pushes to `main`, using `release-please-config.json` and `.release-please-manifest.json`. A release PR is only opened or updated after releasable commits land on `main`.
- `main` is protected by required GitHub checks. Keep the workflow job names `lint`, `typecheck`, and `test` stable unless you are also updating the branch protection/ruleset to match.
- CI and Release Please run on GitHub-hosted runners for this repo. Keep workflow `runs-on` labels aligned with GitHub-hosted images unless a trusted workflow has a specific need for self-hosted infrastructure.
- Do not develop on or manually repurpose the `release-please--branches--main--components--patchrelay` branch. That branch is owned by Release Please.
- If a release PR does not appear after releasable work lands on `main`, check for stale PRs or labels such as `autorelease: pending` / `autorelease: triggered`, then rerun the Release Please workflow.
