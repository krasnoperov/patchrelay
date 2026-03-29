# Release Checklist

PatchRelay and merge-steward releases are automated from `main` with Release Please. This checklist is for maintainers to keep the release pipeline healthy, not for hand-editing versions.

## Pipeline health

- Confirm GitHub Actions is enabled for the repository and the built-in `GITHUB_TOKEN` has permission to create contents, issues, and pull requests for workflows
- Confirm repository settings allow GitHub Actions to create pull requests for this repo
- Confirm the release workflow keeps `id-token: write` so npm trusted publishing can mint an OIDC token
- Confirm npm trusted publishing is configured for **both packages** with this exact repository and workflow file:
  - provider: GitHub Actions
  - owner/repo: `krasnoperov/patchrelay`
  - workflow file: `.github/workflows/release.yml`
  - packages: `patchrelay` and `merge-steward`
- Confirm no long-lived `NPM_TOKEN` is configured for normal releases; trusted publishing should be the default path
- Confirm changes land through branches and pull requests rather than direct feature commits to `main`
- Confirm merged PR titles or squash commit messages use conventional commit style such as `feat:`, `fix:`, or `perf:`

## Before merging to main

- Run `npm ci`
- Run `npm run check`
- Run `npm test` (root PatchRelay tests)
- Run `npm run test -w merge-steward` (steward tests)
- Run `npm run build`
- Run `npm run build -w merge-steward`
- Confirm config examples match the current config surface (`config/patchrelay.example.json`, `config/steward.example.json`)
- Confirm README files reflect the packaged install and service management flow
- Do not hand-edit `package.json`, `package-lock.json`, or `CHANGELOG.md` for normal releases; the release PR owns them

## First publish (chicken-and-egg)

npm trusted publishing requires the package to exist on the registry first. For a new package:

1. Build: `npm run build -w packages/merge-steward`
2. Publish manually with 2FA: `cd packages/merge-steward && npm publish --access public`
3. Configure trusted publishing on npmjs.com for the new package
4. All subsequent releases are automated via Release Please
