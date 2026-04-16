# Changelog

## Unreleased

### Features

* **cli:** new `review-quill pr status` command that classifies the latest non-superseded review attempt and exits 0 approved/skipped / 2 declined/errored/cancelled / 3 still-in-flight / 4 `--wait` timeout.
* **cli:** `attempts`, `transcript`, and `transcript-source` now accept `--repo`/`--pr` flags and also auto-resolve `<repo>` and `<pr-number>` from the current git checkout when both positional arguments are omitted. `--cwd <path>` overrides the resolution directory.
* **cli:** `pr status` supports `--wait`, `--timeout <seconds>`, and `--poll <seconds>` polling so agents can block until a terminal state is reached.

## [0.2.1](https://github.com/krasnoperov/patchrelay/compare/review-quill-v0.2.0...review-quill-v0.2.1) (2026-04-07)


### Bug Fixes

* **review-quill:** trigger release for git auth + sandbox fixes ([0dcb588](https://github.com/krasnoperov/patchrelay/commit/0dcb588ce77c6966337b3ccb183a3ae1aa25dcef))
* **review-quill:** trigger release for git auth + sandbox fixes ([ad565ab](https://github.com/krasnoperov/patchrelay/commit/ad565ab7d7788d7a607c7cd727e1cd79a369b245)), closes [#312](https://github.com/krasnoperov/patchrelay/issues/312)

## [0.2.0](https://github.com/krasnoperov/patchrelay/compare/review-quill-v0.1.0...review-quill-v0.2.0) (2026-04-07)


### Features

* factory control plane with reactive GitHub loops ([#70](https://github.com/krasnoperov/patchrelay/issues/70)) ([04e5cbd](https://github.com/krasnoperov/patchrelay/commit/04e5cbdc9f66f053853cbe2475c9e50a691d830b))


### Bug Fixes

* trigger release for rule-based state machine refactor ([#104](https://github.com/krasnoperov/patchrelay/issues/104)) ([79a7a17](https://github.com/krasnoperov/patchrelay/commit/79a7a17c612a2832b25191af5ff9252deee2b013))
