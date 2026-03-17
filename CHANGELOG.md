# Changelog

## [0.7.7](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.6...patchrelay-v0.7.7) (2026-03-17)


### Bug Fixes

* require native Linear sessions to launch workflows ([452970f](https://github.com/krasnoperov/patchrelay/commit/452970f73bf9232a2dc3900f466baabb30bd7765))

## [0.7.6](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.5...patchrelay-v0.7.6) (2026-03-17)


### Bug Fixes

* use native Linear agent sessions for delegated workflow status ([#37](https://github.com/krasnoperov/patchrelay/issues/37)) ([06c1783](https://github.com/krasnoperov/patchrelay/commit/06c1783d2d2bf1a164807922d7db18ec1fd41797))

## [0.7.5](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.4...patchrelay-v0.7.5) (2026-03-14)


### Bug Fixes

* skip stale release-pr merge watchers ([#35](https://github.com/krasnoperov/patchrelay/issues/35)) ([7104ccc](https://github.com/krasnoperov/patchrelay/commit/7104ccc8fbe269c07032e203600e1932aa64328b))

## [0.7.4](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.3...patchrelay-v0.7.4) (2026-03-14)


### Bug Fixes

* align release app token permissions ([#32](https://github.com/krasnoperov/patchrelay/issues/32)) ([4b89875](https://github.com/krasnoperov/patchrelay/commit/4b89875f41257acc98a5fabded29137a514902f1))
* normalize release-please automation ([#31](https://github.com/krasnoperov/patchrelay/issues/31)) ([6a415f8](https://github.com/krasnoperov/patchrelay/commit/6a415f8d967cfa1a83bb671c69de61002bfb6ade))
* use default release app permissions ([#33](https://github.com/krasnoperov/patchrelay/issues/33)) ([b2b3ad6](https://github.com/krasnoperov/patchrelay/commit/b2b3ad69a41621c748810546963faea0278c5c03))

## [0.7.3](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.2...patchrelay-v0.7.3) (2026-03-14)


### Bug Fixes

* enqueue Start workflows from issue creation by default ([#28](https://github.com/krasnoperov/patchrelay/issues/28)) ([25edf2b](https://github.com/krasnoperov/patchrelay/commit/25edf2bd5e4dc3eecc4343c8f21aa59045242c1d))
* recover interrupted codex runs after restart ([#30](https://github.com/krasnoperov/patchrelay/issues/30)) ([38d7ddd](https://github.com/krasnoperov/patchrelay/commit/38d7dddbc3dfbc51ae5870ff801f8ff9002a149d))

## [0.7.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.1...patchrelay-v0.7.2) (2026-03-14)


### Bug Fixes

* reuse owned worktrees across root drift ([7cfa308](https://github.com/krasnoperov/patchrelay/commit/7cfa308215069d0450f1154c7ab029cbadc536c6))

## [0.7.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.0...patchrelay-v0.7.1) (2026-03-13)


### Bug Fixes

* keep HTTP CLI commands free of sqlite imports ([8b221a6](https://github.com/krasnoperov/patchrelay/commit/8b221a6e20e95fcef16511b0ae80de97254e0510))

## [0.7.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.6.1...patchrelay-v0.7.0) (2026-03-13)


### Features

* refresh cli help and lazy-load sqlite ([ddc22a1](https://github.com/krasnoperov/patchrelay/commit/ddc22a1cfd89ea9b0e93776902efd6a31d89ae4a))

## [0.6.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.6.0...patchrelay-v0.6.1) (2026-03-13)


### Bug Fixes

* prefer bundled build metadata ([9e4cadf](https://github.com/krasnoperov/patchrelay/commit/9e4cadfaefb8c64501a0d19b79f689bbc7899d32))

## [0.6.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.5.1...patchrelay-v0.6.0) (2026-03-13)


### Features

* add version CLI command ([66447c7](https://github.com/krasnoperov/patchrelay/commit/66447c7bdca8764794788d86aa1727545e3ba1e3))

## [0.5.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.5.0...patchrelay-v0.5.1) (2026-03-13)


### Bug Fixes

* complete CI pre-merge coverage ([39383f3](https://github.com/krasnoperov/patchrelay/commit/39383f307a9bb1b4cbafe1650b3c794cfbb53c3a))

## [0.5.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.4.1...patchrelay-v0.5.0) (2026-03-13)


### Features

* add operator feed and harden CLI flows ([#14](https://github.com/krasnoperov/patchrelay/issues/14)) ([33193e9](https://github.com/krasnoperov/patchrelay/commit/33193e99ef75566772a62f8019ce382a2203082a))

## [0.4.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.4.0...patchrelay-v0.4.1) (2026-03-13)


### Bug Fixes

* verify database schema health in doctor ([6c7221d](https://github.com/krasnoperov/patchrelay/commit/6c7221db17b8bf09e8b5108d98a345586eeaf923))

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
