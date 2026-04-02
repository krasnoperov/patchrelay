# Changelog

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
