# Changelog

## Unreleased

### Features

* **cli:** new `merge-steward pr status` command that classifies a single PR (queue entry first, GitHub fallback) and exits 0 terminal-ok / 2 terminal-failure / 3 still-in-flight / 4 `--wait` timeout so agent scripts can chain with `&&`.
* **cli:** `queue status`, `queue show`, and `queue reconcile` now infer `--repo` from the current git checkout (via `origin`'s remote URL) when the flag is omitted. `--cwd <path>` overrides the resolution directory.
* **cli:** `pr status` supports `--wait`, `--timeout <seconds>`, and `--poll <seconds>` polling so agents can block until a terminal state is reached.

## [0.9.6](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.9.5...merge-steward-v0.9.6) (2026-04-07)


### Bug Fixes

* **review-quill:** trigger release for git auth + sandbox fixes ([0dcb588](https://github.com/krasnoperov/patchrelay/commit/0dcb588ce77c6966337b3ccb183a3ae1aa25dcef))
* **review-quill:** trigger release for git auth + sandbox fixes ([ad565ab](https://github.com/krasnoperov/patchrelay/commit/ad565ab7d7788d7a607c7cd727e1cd79a369b245)), closes [#312](https://github.com/krasnoperov/patchrelay/issues/312)

## [0.9.5](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.9.4...merge-steward-v0.9.5) (2026-04-03)


### Bug Fixes

* operational reliability — health gate, label retry, provenance, reset ([f27ac71](https://github.com/krasnoperov/patchrelay/commit/f27ac7166d89f38463c8f2b8f622e6b06845ce39))
* operational reliability — health gate, label retry, provenance, reset ([bfd926a](https://github.com/krasnoperov/patchrelay/commit/bfd926a8dc40c57bd08a6cd96e7e0c6bf13f9405))

## [0.9.4](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.9.3...merge-steward-v0.9.4) (2026-04-03)


### Bug Fixes

* complete dequeue invalidation — service, harness, external merge ([00f5499](https://github.com/krasnoperov/patchrelay/commit/00f54994119f7c6c4bce8c11bcfe831cb9bb7486))
* complete dequeue invalidation — service, harness, external merge ([4cc6298](https://github.com/krasnoperov/patchrelay/commit/4cc629889c931ce25145d1cf6e82b34c6500bcb2))

## [0.9.3](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.9.2...merge-steward-v0.9.3) (2026-04-03)


### Bug Fixes

* add stale dependency guard in reconciler + dequeue contamination tests ([6b330b6](https://github.com/krasnoperov/patchrelay/commit/6b330b6c3fd6a4de4f8e8a6f11d531dbae1e3aa7))
* stale dependency guard in reconciler + dequeue contamination tests ([7778ff5](https://github.com/krasnoperov/patchrelay/commit/7778ff5eb5a103b0d8e695a0975c2eb59b5a6c01))

## [0.9.2](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.9.1...merge-steward-v0.9.2) (2026-04-03)


### Bug Fixes

* invalidate downstream specs on mid-queue dequeue ([2011909](https://github.com/krasnoperov/patchrelay/commit/201190984a34cc131bfd3863d7eb345d64a0a246))
* invalidate downstream specs on mid-queue dequeue ([f87fb5f](https://github.com/krasnoperov/patchrelay/commit/f87fb5f4bbc30ba68a7b2cad7336fe3e7511525f))

## [0.9.1](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.9.0...merge-steward-v0.9.1) (2026-04-03)


### Bug Fixes

* use patience diff algorithm for spec merges ([38c198e](https://github.com/krasnoperov/patchrelay/commit/38c198e25f3452aebea9dfff95f2571d3d7c006a))
* use patience diff algorithm for spec merges ([2822deb](https://github.com/krasnoperov/patchrelay/commit/2822deb634000974b2e4a544882d1365ef638b5d))

## [0.9.0](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.13...merge-steward-v0.9.0) (2026-04-03)


### Features

* configurable auto-resolve patterns for merge conflicts ([59ee2cc](https://github.com/krasnoperov/patchrelay/commit/59ee2cc7a286d3a2c4743ccc84e8f0fe3d58fba7))
* configurable auto-resolve patterns for merge conflicts ([1c0a2f2](https://github.com/krasnoperov/patchrelay/commit/1c0a2f26ff05426f0d917b2c3bdc2001aa21456f))

## [0.8.13](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.12...merge-steward-v0.8.13) (2026-04-03)


### Bug Fixes

* support pnpm and yarn lockfile auto-resolve in spec builds ([7f9c5c9](https://github.com/krasnoperov/patchrelay/commit/7f9c5c9ae69e78c610e569001a4006aa50045c1b))
* support pnpm and yarn lockfile auto-resolve in spec builds ([4fee9ef](https://github.com/krasnoperov/patchrelay/commit/4fee9ef723c8453b39c956eefd033a3369b7dd7d))

## [0.8.12](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.11...merge-steward-v0.8.12) (2026-04-03)


### Bug Fixes

* **merge-steward:** reject skipped required checks ([2ba38f9](https://github.com/krasnoperov/patchrelay/commit/2ba38f91f80338d0a65095ac54cf5f23c52401b7))
* **merge-steward:** reject skipped required checks instead of passing them ([4ab10e5](https://github.com/krasnoperov/patchrelay/commit/4ab10e532eabe49f47e156aca6f24cece12546c4))

## [0.8.11](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.10...merge-steward-v0.8.11) (2026-04-03)


### Bug Fixes

* reliability batch — merged-PR guards, startup scan, commit messages ([2129d8a](https://github.com/krasnoperov/patchrelay/commit/2129d8a1eb3ea330a8987f4949a9d57aa4201e0f))
* reliability batch — merged-PR guards, startup scan, commit messages ([b306a00](https://github.com/krasnoperov/patchrelay/commit/b306a006dc29f380a2179ef54f5d35818a48482c))

## [0.8.10](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.9...merge-steward-v0.8.10) (2026-04-03)


### Bug Fixes

* attribute steward merge commits to bot identity ([e16695d](https://github.com/krasnoperov/patchrelay/commit/e16695d7912b7478c92fd4ff8382696461913084))
* attribute steward merge commits to discovered bot identity ([82774ab](https://github.com/krasnoperov/patchrelay/commit/82774ab1f33c03c65e863174c83698d812220c70))

## [0.8.9](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.8...merge-steward-v0.8.9) (2026-04-03)


### Bug Fixes

* push spec branch to remote before triggering CI ([3ad6b2f](https://github.com/krasnoperov/patchrelay/commit/3ad6b2f98e46f58d0a93173c91d3e2ae729f0bf3))
* push spec branch to remote before triggering CI ([63e0b84](https://github.com/krasnoperov/patchrelay/commit/63e0b84c13370529c8dc3c2913a9d5d93bf16fd8))

## [0.8.8](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.7...merge-steward-v0.8.8) (2026-04-03)


### Bug Fixes

* use explicit origin/ prefix for PR branches in worktree merges ([8a36f36](https://github.com/krasnoperov/patchrelay/commit/8a36f36114581465a0027d3bcd83a1efb7117935))
* use explicit origin/ prefix for PR branches in worktree merges ([52b3e65](https://github.com/krasnoperov/patchrelay/commit/52b3e65b6870f4d86ab458c1a83395e4371fe583))

## [0.8.7](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.6...merge-steward-v0.8.7) (2026-04-03)


### Bug Fixes

* harden buildSpeculative against stale clone and lockfile conflicts ([0a78f9d](https://github.com/krasnoperov/patchrelay/commit/0a78f9dd408f53fcf920cf70f51e16076d07770a))
* harden buildSpeculative against stale clone and lockfile conflicts ([14b2466](https://github.com/krasnoperov/patchrelay/commit/14b2466d1a0ce7a1ce572632b83e1d56b22b2397))
* use isolated git worktrees for speculative branch builds ([ea40e85](https://github.com/krasnoperov/patchrelay/commit/ea40e8554c29e7453489668d059cea3937155160))
* use isolated git worktrees for speculative branch builds ([1243adb](https://github.com/krasnoperov/patchrelay/commit/1243adbc7ad98662265a07fe25c5dc583637c153))

## [0.8.6](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.5...merge-steward-v0.8.6) (2026-04-02)


### Bug Fixes

* **merge-steward:** clear retry gate when GitHub reports CLEAN ([307d100](https://github.com/krasnoperov/patchrelay/commit/307d100f75a1c028482b861df1640847fdb7aff1))
* **merge-steward:** clear retry gate when GitHub reports PR is CLEAN ([0e07568](https://github.com/krasnoperov/patchrelay/commit/0e075685df29dad006786a1a690e7a54d320e4b4))

## [0.8.5](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.4...merge-steward-v0.8.5) (2026-04-02)


### Bug Fixes

* **merge-steward:** --version flag and shorter hashes in watch ([7077a5b](https://github.com/krasnoperov/patchrelay/commit/7077a5b7bbf2acf75b6b1578442634bd73bd1d5e))
* **merge-steward:** add --version flag, truncate long hashes in event display ([8585e24](https://github.com/krasnoperov/patchrelay/commit/8585e2419fa1c3ce4bbad94142ecf86878c6736b))

## [0.8.4](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.3...merge-steward-v0.8.4) (2026-04-02)


### Bug Fixes

* **merge-steward:** shorten CI run IDs in transition detail strings ([d9984e7](https://github.com/krasnoperov/patchrelay/commit/d9984e7d1bd9107df7c1a01f013fd681ca5f764d))
* **merge-steward:** shorten hashes in event details ([a7dab3f](https://github.com/krasnoperov/patchrelay/commit/a7dab3f93824b24b64e65947d258a0caf7c555eb))

## [0.8.3](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.2...merge-steward-v0.8.3) (2026-04-02)


### Bug Fixes

* **merge-steward:** align terminal rows, clean up detail view ([b4b2087](https://github.com/krasnoperov/patchrelay/commit/b4b20875342d53871da757cdb3c0b3dbf347762d))
* **merge-steward:** fix misleading status text and humanize event log ([b74f511](https://github.com/krasnoperov/patchrelay/commit/b74f5116c26ab539c5ee3816a9f1d7bf17a12ea5))
* **merge-steward:** fix strict typecheck for optional color prop ([2e93c2b](https://github.com/krasnoperov/patchrelay/commit/2e93c2bf3dacf57e76b57e574373765a6e4be67f))
* **merge-steward:** pad relative time to 4 chars for aligned columns ([f4b7528](https://github.com/krasnoperov/patchrelay/commit/f4b7528d3a3daa65ce793e7226785f906c6d61a8))
* **merge-steward:** queued status says 'starting shortly' not 'next tick' ([fbcc9db](https://github.com/krasnoperov/patchrelay/commit/fbcc9db9382bee29cc37683abc7fd558074f0402))
* **merge-steward:** replace bracket state graph with dot notation ([8c86ae5](https://github.com/krasnoperov/patchrelay/commit/8c86ae5d39400941536ff8293f5c6e3767adba3b))
* **merge-steward:** separate chain header from display filter ([5fa1b7b](https://github.com/krasnoperov/patchrelay/commit/5fa1b7b553a599299635739aec6c2523b4cde39a))
* **merge-steward:** simplify queue row to one line, remove visual noise ([2ba1058](https://github.com/krasnoperov/patchrelay/commit/2ba1058c27ef7015cc82e0c65df0fd7a0f728859))
* **merge-steward:** wait for re-approval instead of evicting, check all branches ([a6a49fe](https://github.com/krasnoperov/patchrelay/commit/a6a49fece67c4f94e8ca6ddc447a09fc8e2aa2cd))
* replace implementation jargon with operator-facing language ([f6845c7](https://github.com/krasnoperov/patchrelay/commit/f6845c738ab4e3fdf7ee5982de2c5e1b771fff64))
* update integration tests for non-null specBuilder and branch setup ([3044ba9](https://github.com/krasnoperov/patchrelay/commit/3044ba9c6727477e4f46ba8dc57584d1f7dd6413))

## [0.8.2](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.1...merge-steward-v0.8.2) (2026-04-02)


### Bug Fixes

* **merge-steward:** deduplicate chain by prNumber to handle re-admission ([ae64349](https://github.com/krasnoperov/patchrelay/commit/ae643491db047155587ae36929a94e042a828941))
* **merge-steward:** deduplicate chain header by PR number ([5dffbd7](https://github.com/krasnoperov/patchrelay/commit/5dffbd7e5be870fff3f2dea12f5f6dc1098db071))

## [0.8.1](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.8.0...merge-steward-v0.8.1) (2026-04-02)


### Bug Fixes

* **merge-steward:** chain header includes recently-merged entries ([cb48fa1](https://github.com/krasnoperov/patchrelay/commit/cb48fa185af33a899a0970719888a035992eb4ea))
* **merge-steward:** include recently-merged entries in spec chain header ([37dfcea](https://github.com/krasnoperov/patchrelay/commit/37dfcea6c8eec260fe23967f33f35f7c5d3f03a8))

## [0.8.0](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.7.0...merge-steward-v0.8.0) (2026-04-02)


### Features

* **merge-steward:** spec chain progress and recently-completed entries ([a489180](https://github.com/krasnoperov/patchrelay/commit/a489180f20c842a01eb05cd8229dde0149ba43d5))
* **merge-steward:** spec chain summary line and recently-completed entries ([11143ac](https://github.com/krasnoperov/patchrelay/commit/11143ac1b78dc79c688409d80d1037aa29e3a9b4))

## [0.7.0](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.6.0...merge-steward-v0.7.0) (2026-04-02)


### Features

* **merge-steward:** improve watch with spec chain, retry-gate, cascade visibility ([d17b165](https://github.com/krasnoperov/patchrelay/commit/d17b165d8e4bc21b0c6421d137aa29d4391444db))
* **merge-steward:** spec chain and retry-gate visibility in watch ([5ee3c70](https://github.com/krasnoperov/patchrelay/commit/5ee3c70c401d3636e74f1d31f7cee1647a2e463a))

## [0.6.0](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.5.6...merge-steward-v0.6.0) (2026-04-02)


### Features

* **merge-steward:** speculative-only mode — push spec branches to main ([4e81eff](https://github.com/krasnoperov/patchrelay/commit/4e81efffe3d6dfc1cbe3041778dd99cd7f08e24c))


### Bug Fixes

* **merge-steward:** add queue sanitation, error context, and duplicate handling ([d4e0e7a](https://github.com/krasnoperov/patchrelay/commit/d4e0e7a180fe589c749fb63586e4ef824d1601f5))
* **merge-steward:** fix strict typecheck errors ([746c575](https://github.com/krasnoperov/patchrelay/commit/746c5750a3e40d769a3ad02ad2db8046a9436d44))
* **merge-steward:** invalidate downstream on push failure, fix duplicate ordering ([60ed31f](https://github.com/krasnoperov/patchrelay/commit/60ed31f238b3498c642b0057aa5e4c2bdf88fa8e))
* steward queue sanitation and speculative-only merge ([064cf97](https://github.com/krasnoperov/patchrelay/commit/064cf973c6be5538eff02e51c7805c264dfac964))

## [0.5.6](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.5.5...merge-steward-v0.5.6) (2026-04-01)


### Bug Fixes

* **merge-steward:** evict dirty retry-gated queue heads ([19638e9](https://github.com/krasnoperov/patchrelay/commit/19638e9ba80bf89ee747115cae34876feedc7b6e))
* **merge-steward:** evict dirty retry-gated queue heads ([81ca480](https://github.com/krasnoperov/patchrelay/commit/81ca4802198981f6a07bd323dea26fac02591758))

## [0.5.5](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.5.4...merge-steward-v0.5.5) (2026-04-01)


### Bug Fixes

* clarify queue status and effective checks ([f9a9e67](https://github.com/krasnoperov/patchrelay/commit/f9a9e677b5c8d65ed0ebe2748720a169f678dd04))
* clarify queue status and effective checks ([625ed8c](https://github.com/krasnoperov/patchrelay/commit/625ed8ce477375c18ffd9ec62c139fb4e85aee03))

## [0.5.4](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.5.3...merge-steward-v0.5.4) (2026-04-01)


### Bug Fixes

* refresh queued branches with merges ([3be7586](https://github.com/krasnoperov/patchrelay/commit/3be75861d63333eec67dbd338e55db1761cba891))
* refresh queued branches with merges ([22d01f9](https://github.com/krasnoperov/patchrelay/commit/22d01f9bb47487f1fe7f5eadcce3142737f51d15))

## [0.5.3](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.5.2...merge-steward-v0.5.3) (2026-04-01)


### Bug Fixes

* clarify dashboard and queue status ([99e19a5](https://github.com/krasnoperov/patchrelay/commit/99e19a5e014836170a9a06f396662ff5e4fa212b))
* clarify dashboard and queue status ([e0df22b](https://github.com/krasnoperov/patchrelay/commit/e0df22bbbf281f27888a515bb4aa11202ee021a4))

## [0.5.2](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.5.1...merge-steward-v0.5.2) (2026-04-01)


### Bug Fixes

* prevent queued branch rollback ([43c63c8](https://github.com/krasnoperov/patchrelay/commit/43c63c85a3df525f3df15d507ada0da3dea9112c))
* prevent queued branch rollback ([6052e9b](https://github.com/krasnoperov/patchrelay/commit/6052e9b1b71208982c9a69dbf73db14933d502b0))
* stabilize dashboard and delegated issue recovery ([0b610f9](https://github.com/krasnoperov/patchrelay/commit/0b610f9360ffa105c624835ebc239e2688d50f00))
* sync queued rebases to remote heads ([be5940c](https://github.com/krasnoperov/patchrelay/commit/be5940cf7369b9ad27503c89a63765cb2a12aef0))

## [0.5.1](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.5.0...merge-steward-v0.5.1) (2026-04-01)


### Bug Fixes

* tighten dependency readiness semantics ([2c02792](https://github.com/krasnoperov/patchrelay/commit/2c0279247bdb8f1d59b7256c7d5f89f0fdfefe5c))
* tighten dependency readiness semantics ([257cfca](https://github.com/krasnoperov/patchrelay/commit/257cfcabaa643f9bb0a6ab021ba4093b037713c2))

## [0.5.0](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.4.1...merge-steward-v0.5.0) (2026-04-01)


### Features

* gate blocked work and surface queue pauses ([06735d7](https://github.com/krasnoperov/patchrelay/commit/06735d7fd5b04169b2947097d28828809e5355d6))
* surface queue blocks from unhealthy main ([1aad5a2](https://github.com/krasnoperov/patchrelay/commit/1aad5a2f3bc82a4b81c9da414cf0fffe4f675735))

## [0.4.1](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.4.0...merge-steward-v0.4.1) (2026-04-01)


### Bug Fixes

* stabilize queue handoff and steward admission ([4d0ada7](https://github.com/krasnoperov/patchrelay/commit/4d0ada794d15c1296c263f508ed903f13cc6af2a))
* stabilize queue handoff and steward admission ([03bf90a](https://github.com/krasnoperov/patchrelay/commit/03bf90a20e2ad017f335384d0c0e70b5c66bcaf8))

## [0.4.0](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.3.0...merge-steward-v0.4.0) (2026-03-31)


### Features

* add GitHub App auth for merge-steward ([1baa29b](https://github.com/krasnoperov/patchrelay/commit/1baa29b8fff61408251247f6d10c6e4d1023da48))
* move merge-steward GitHub discovery behind the service ([5f8fe46](https://github.com/krasnoperov/patchrelay/commit/5f8fe46171b0a55eb99c27d7f3ed70ad800191f4))
* simplify merge-steward setup and service ops ([d977160](https://github.com/krasnoperov/patchrelay/commit/d9771604468b7bd16488111dcc63d4856d73bcde))
* switch patchrelay to workspace and repo linking ([c72aefe](https://github.com/krasnoperov/patchrelay/commit/c72aefea3cb5621961c3e86a6b4bbaea28bda5b8))

## [0.3.0](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.2.0...merge-steward-v0.3.0) (2026-03-31)


### Features

* harden merge queue contract and repair handoff ([8c41ee3](https://github.com/krasnoperov/patchrelay/commit/8c41ee3296618dc38fa6f0d5c27ac4addad21714))
* harden merge queue contract and repair handoff ([efa56fb](https://github.com/krasnoperov/patchrelay/commit/efa56fbb3a274c17591790dec13e374bd9672f50))

## [0.2.0](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.1.0...merge-steward-v0.2.0) (2026-03-30)


### Features

* multi-repo merge-steward server with unified webhook endpoint ([#203](https://github.com/krasnoperov/patchrelay/issues/203)) ([0f9e237](https://github.com/krasnoperov/patchrelay/commit/0f9e237c9d90480d44eb4e43d91c8be2f2dd338a))

## [0.1.0](https://github.com/krasnoperov/patchrelay/compare/merge-steward-v0.0.1...merge-steward-v0.1.0) (2026-03-30)


### Features

* factory control plane with reactive GitHub loops ([#70](https://github.com/krasnoperov/patchrelay/issues/70)) ([04e5cbd](https://github.com/krasnoperov/patchrelay/commit/04e5cbdc9f66f053853cbe2475c9e50a691d830b))
* merge-steward workspace with Phase 1 serial reconciler ([#201](https://github.com/krasnoperov/patchrelay/issues/201)) ([8df250e](https://github.com/krasnoperov/patchrelay/commit/8df250ec66bbe37add1746674fb6ffaf7a1ecddf))


### Bug Fixes

* trigger release for rule-based state machine refactor ([#104](https://github.com/krasnoperov/patchrelay/issues/104)) ([79a7a17](https://github.com/krasnoperov/patchrelay/commit/79a7a17c612a2832b25191af5ff9252deee2b013))

## Changelog
