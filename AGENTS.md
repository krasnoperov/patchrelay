# Agent instructions

## Git

- Never squash-merge PRs. Use regular merge (`--merge`) to preserve commit history.

## Releases

- For changes that should affect npm version bumps, use conventional commit subjects on the actual branch commits, for example `fix: ...`, `feat: ...`, or `refactor!: ...`.
- PR titles and merge commit titles do not control release versioning here; the release planner reads non-merge commit subjects.
- Keep release-related workflow or package changes small and explicit so the release planner can attribute them to the correct package.

## PatchRelay Workflow

- PatchRelay must not hand off the same PR head back to review after requested changes. A requested-changes repair must produce a new pushed head before the issue can return to review.
- If the app-server terminates, loses the turn, or otherwise finishes requested-changes work without pushing a new head, treat that as a PatchRelay/system failure that must be evaluated and fixed in PatchRelay so the state cannot recur.

## Architecture

- Keep orchestrators, handlers, and service shells narrow. If a file starts mixing orchestration, policy, persistence, and read-model shaping, extract by responsibility before adding more behavior.
- For the detailed guidance and extraction order, see [docs/architecture-guardrails.md](docs/architecture-guardrails.md).
