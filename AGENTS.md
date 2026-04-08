# Agent instructions

## Git

- Never squash-merge PRs. Use regular merge (`--merge`) to preserve commit history.

## Releases

- For changes that should affect npm version bumps, use conventional commit subjects on the actual branch commits, for example `fix: ...`, `feat: ...`, or `refactor!: ...`.
- PR titles and merge commit titles do not control release versioning here; the release planner reads non-merge commit subjects.
- Keep release-related workflow or package changes small and explicit so the release planner can attribute them to the correct package.
