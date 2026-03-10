# Release Checklist

PatchRelay releases are automated from `main` with Release Please. This checklist is for maintainers to keep the release pipeline healthy, not for hand-editing versions.

- Confirm GitHub Actions is enabled for the repository and the built-in `GITHUB_TOKEN` has permission to create contents, issues, and pull requests for workflows
- Confirm repository settings allow GitHub Actions to create pull requests for this repo
- Confirm the release workflow keeps `id-token: write` so npm trusted publishing can mint an OIDC token
- Confirm npm trusted publishing is configured for this exact repository and workflow file:
  - provider: GitHub Actions
  - owner/repo: `krasnoperov/patchrelay`
  - workflow file: `.github/workflows/release.yml`
- Confirm no long-lived `NPM_TOKEN` is configured for normal releases; trusted publishing should be the default path
- Confirm changes land through branches and pull requests rather than direct feature commits to `main`
- Confirm merged PR titles or squash commit messages use conventional commit style such as `feat:`, `fix:`, or `perf:`
- Run `npm ci`
- Run `npm run check`
- Run `npm test`
- Run `npm run build`
- Confirm `.env.example` and `config/patchrelay.example.yaml` match the current config surface
- Confirm README and self-hosting docs reflect the packaged install, service management flow, and public routes
- Confirm `/api` operator routes are disabled by default
- Confirm `/ready` behavior matches the startup model
- Review webhook archival and logging behavior for sensitive data handling
- Do not hand-edit `package.json`, `package-lock.json`, or `CHANGELOG.md` for normal releases; the release PR owns them
