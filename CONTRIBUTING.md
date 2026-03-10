# Contributing

PatchRelay is currently focused on a self-hosted Linear-to-Codex workflow. The best contributions are narrowly scoped changes that improve reliability, operator safety, observability, and documentation.

## Local development

1. Install Node.js 24 and `npm`.
2. Run `npm ci`.
3. Run `npm run check`.
4. Run `npm test`.
5. Run `npm run build` before opening a pull request if you changed runtime code.

## Pull request guidelines

- Add or update tests when behavior changes.
- Update docs and examples when config or operational behavior changes.
- Keep security-sensitive changes small and well explained.
- Avoid breaking the documented self-hosting flow without a migration note.
