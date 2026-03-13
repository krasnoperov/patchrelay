# Changelog

## [0.4.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.3.0...patchrelay-v0.4.0) (2026-03-13)


### Features

* persist issue session handoff history for open ([45e6bb6](https://github.com/krasnoperov/patchrelay/commit/45e6bb6ccbfd822d12487e3ee7d52c0af7e69105))

## [0.3.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.2.0...patchrelay-v0.3.0) (2026-03-13)


### Features

* separate workflow coordination from query and cli dispatch ([e40a046](https://github.com/krasnoperov/patchrelay/commit/e40a046e95869e8f064a7a4b4bcd0e9c18e5c8f6))

## [0.2.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.1.0...patchrelay-v0.2.0) (2026-03-12)


### Features

* add public ingress configuration ([aa365d6](https://github.com/krasnoperov/patchrelay/commit/aa365d6a70c3f3d2de7cfe58b2316f229cae9ae6))
* **runtime:** simplify health and zmx session naming ([602ad79](https://github.com/krasnoperov/patchrelay/commit/602ad79815b0ebeeed278db144e1137d69f4357c))
* separate mention sessions from delegated workflows ([fa8a4a9](https://github.com/krasnoperov/patchrelay/commit/fa8a4a9ff89b32a5896e5c8aefd766b512923aad))
* **webhooks:** build status-driven patchrelay v1 ([ad1945a](https://github.com/krasnoperov/patchrelay/commit/ad1945a353afb77d45f5abed1c7297dbea76c69d))

## Changelog

All notable changes to this project will be documented in this file.

PatchRelay is currently in active pre-1.0 development. Releases follow semver-style versioning with a stricter rule for `0.x`:

- `fix:` releases bump the patch version
- `feat:` releases bump the minor version
- breaking changes still bump the minor version until the project is ready for `1.0.0`

From this point forward, the changelog is maintained automatically by Release Please.
