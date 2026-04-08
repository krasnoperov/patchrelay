# Agent instructions

## Git

- Never squash-merge PRs. Use regular merge (`--merge`) to preserve commit history.

## Releases

- For changes that should affect npm version bumps, use conventional commit subjects on the actual branch commits, for example `fix: ...`, `feat: ...`, or `refactor!: ...`.
- PR titles and merge commit titles do not control release versioning here; the release planner reads non-merge commit subjects.
- Keep release-related workflow or package changes small and explicit so the release planner can attribute them to the correct package.

## Review Handoff

- PatchRelay must not hand off the same PR head back to review after requested changes.
- If requested-changes work ends without a new pushed head because the app-server turn failed, that is a PatchRelay/system failure and must be evaluated and fixed in PatchRelay rather than papered over with a re-review handoff.
