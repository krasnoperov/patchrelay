# Contributing

PatchRelay is currently focused on a self-hosted execution harness for Linear-driven Codex work. The best contributions are narrowly scoped changes that improve reliability, operator safety, observability, and documentation.

## Local development

1. Install Node.js 24 and enable `pnpm` with Corepack.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm check`.
4. Run `pnpm test`.
5. Run `pnpm build` before opening a pull request if you changed runtime code.

## Pull request guidelines

- Do feature work in branches and open pull requests into `main`.
- **Use regular merges (`gh pr merge --merge`), never squash.** Release-please reads non-merge commit subjects to plan version bumps — squashing drops that signal and breaks the release workflow.
- Use conventional commit style on the actual branch commits (not just the PR title), for example `feat: add project bootstrap wizard` or `fix: validate reused worktree paths`.
- Add or update tests when behavior changes.
- Update docs and examples when config or operational behavior changes.
- Keep security-sensitive changes small and well explained.
- Avoid breaking the documented self-hosting flow without a migration note.

## Release policy

- PatchRelay is intentionally pre-1.0 for now. Do not hand-edit versions for feature work.
- The Release workflow runs from `main`, computes package-specific changes since the last `ci: release` marker, bumps touched package versions, commits the marker, publishes with `pnpm publish`, and pushes release tags.
- Conventional commit subjects on non-merge branch commits control version bumps. `feat:` bumps minor, `fix:` and other conventional subjects bump patch, and breaking changes bump minor while packages remain below `1.0.0`.
- Documentation-only commits do not publish packages unless they touch package-owned files.
- Use `pnpm view <package> version` to verify registry publication before deploying updated services.
