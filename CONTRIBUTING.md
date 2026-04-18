# Contributing

PatchRelay is currently focused on a self-hosted execution harness for Linear-driven Codex work. The best contributions are narrowly scoped changes that improve reliability, operator safety, observability, and documentation.

## Local development

1. Install Node.js 24 and `npm`.
2. Run `npm ci`.
3. Run `npm run check`.
4. Run `npm test`.
5. Run `npm run build` before opening a pull request if you changed runtime code.

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
- Releases are generated automatically from `main` with Release Please.
- Release Please opens a release PR that updates `package.json`, `package-lock.json`, and `CHANGELOG.md`.
- Merging that release PR creates the GitHub release and publishes the matching npm package automatically through npm trusted publishing.
- While PatchRelay is below `1.0.0`, `feat:` changes bump the minor version and `fix:` changes bump the patch version.
- Breaking changes also bump the minor version until the project is explicitly declared stable enough for `1.0.0`.
