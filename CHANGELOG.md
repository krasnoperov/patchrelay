# Changelog

## [0.10.7](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.10.6...patchrelay-v0.10.7) (2026-03-22)


### Bug Fixes

* polish run behavior from USE-67 session observations ([#90](https://github.com/krasnoperov/patchrelay/issues/90)) ([16dabb8](https://github.com/krasnoperov/patchrelay/commit/16dabb8b0f9b3daf4d88bcb56ab9327b25e956f3))

## [0.10.6](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.10.5...patchrelay-v0.10.6) (2026-03-22)


### Bug Fixes

* prevent check event flickering, stale issue reads, and aggressive pr_closed ([#88](https://github.com/krasnoperov/patchrelay/issues/88)) ([01ce7ad](https://github.com/krasnoperov/patchrelay/commit/01ce7adb8786fa0779317760c2ab00731451a68f))

## [0.10.5](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.10.4...patchrelay-v0.10.5) (2026-03-22)


### Bug Fixes

* remove non-actionable webhook queue warning from doctor ([#85](https://github.com/krasnoperov/patchrelay/issues/85)) ([606c8b3](https://github.com/krasnoperov/patchrelay/commit/606c8b3632238594137fb3496312161a08b2e55c))

## [0.10.4](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.10.3...patchrelay-v0.10.4) (2026-03-22)


### Bug Fixes

* mark GitHub dedupe-only webhooks as processed, clean up stale backlog ([#83](https://github.com/krasnoperov/patchrelay/issues/83)) ([5d17314](https://github.com/krasnoperov/patchrelay/commit/5d173143238ba06034e409d590041b150e9e481f))

## [0.10.3](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.10.2...patchrelay-v0.10.3) (2026-03-22)


### Bug Fixes

* refresh workspace identity on connect reuse, show versions in doctor ([#81](https://github.com/krasnoperov/patchrelay/issues/81)) ([0909fda](https://github.com/krasnoperov/patchrelay/commit/0909fdae7746af340605c7d596c05e940d2e0521))

## [0.10.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.10.1...patchrelay-v0.10.2) (2026-03-22)


### Bug Fixes

* show project routing in patchrelay installations output ([#79](https://github.com/krasnoperov/patchrelay/issues/79)) ([fac389d](https://github.com/krasnoperov/patchrelay/commit/fac389d4e83b506f0b55ba60f7ad70aaec73ac69))

## [0.10.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.10.0...patchrelay-v0.10.1) (2026-03-22)


### Bug Fixes

* use Linear organization name for workspace identity, not first team name ([#77](https://github.com/krasnoperov/patchrelay/issues/77)) ([85abd92](https://github.com/krasnoperov/patchrelay/commit/85abd92bc01b1bb71173442d7d65252525331fe0))

## [0.10.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.9.2...patchrelay-v0.10.0) (2026-03-22)


### Features

* add operator feed and harden CLI flows ([#14](https://github.com/krasnoperov/patchrelay/issues/14)) ([33193e9](https://github.com/krasnoperov/patchrelay/commit/33193e99ef75566772a62f8019ce382a2203082a))
* add public ingress configuration ([aa365d6](https://github.com/krasnoperov/patchrelay/commit/aa365d6a70c3f3d2de7cfe58b2316f229cae9ae6))
* add repo-local workflows and workflow timeline ([6a3d3a4](https://github.com/krasnoperov/patchrelay/commit/6a3d3a4e8036ed783a4a22a37332242c5d73ae89))
* add version CLI command ([66447c7](https://github.com/krasnoperov/patchrelay/commit/66447c7bdca8764794788d86aa1727545e3ba1e3))
* factory control plane with reactive GitHub loops ([#70](https://github.com/krasnoperov/patchrelay/issues/70)) ([04e5cbd](https://github.com/krasnoperov/patchrelay/commit/04e5cbdc9f66f053853cbe2475c9e50a691d830b))
* persist issue session handoff history for open ([45e6bb6](https://github.com/krasnoperov/patchrelay/commit/45e6bb6ccbfd822d12487e3ee7d52c0af7e69105))
* refresh cli help and lazy-load sqlite ([ddc22a1](https://github.com/krasnoperov/patchrelay/commit/ddc22a1cfd89ea9b0e93776902efd6a31d89ae4a))
* **runtime:** simplify health and zmx session naming ([602ad79](https://github.com/krasnoperov/patchrelay/commit/602ad79815b0ebeeed278db144e1137d69f4357c))
* separate mention sessions from delegated workflows ([fa8a4a9](https://github.com/krasnoperov/patchrelay/commit/fa8a4a9ff89b32a5896e5c8aefd766b512923aad))
* separate workflow coordination from query and cli dispatch ([e40a046](https://github.com/krasnoperov/patchrelay/commit/e40a046e95869e8f064a7a4b4bcd0e9c18e5c8f6))
* **webhooks:** build status-driven patchrelay v1 ([ad1945a](https://github.com/krasnoperov/patchrelay/commit/ad1945a353afb77d45f5abed1c7297dbea76c69d))


### Bug Fixes

* accept delegated Linear agent sessions natively ([325643b](https://github.com/krasnoperov/patchrelay/commit/325643bb13aeb3110bc7bbe7b3f4fc353f7a7e4e))
* align release app token permissions ([#32](https://github.com/krasnoperov/patchrelay/issues/32)) ([4b89875](https://github.com/krasnoperov/patchrelay/commit/4b89875f41257acc98a5fabded29137a514902f1))
* complete CI pre-merge coverage ([39383f3](https://github.com/krasnoperov/patchrelay/commit/39383f307a9bb1b4cbafe1650b3c794cfbb53c3a))
* consolidate CI into single job, support --version flag ([#74](https://github.com/krasnoperov/patchrelay/issues/74)) ([a553cad](https://github.com/krasnoperov/patchrelay/commit/a553cad7abc48652196f02ddc115443d890ae09e))
* enqueue Start workflows from issue creation by default ([#28](https://github.com/krasnoperov/patchrelay/issues/28)) ([25edf2b](https://github.com/krasnoperov/patchrelay/commit/25edf2bd5e4dc3eecc4343c8f21aa59045242c1d))
* honor live terminal Linear states over stale stage work ([#57](https://github.com/krasnoperov/patchrelay/issues/57)) ([b1057fc](https://github.com/krasnoperov/patchrelay/commit/b1057fc249748b4ffca7de87a67c7d3e83162523))
* hydrate sparse Linear agent session issues ([a43a5a2](https://github.com/krasnoperov/patchrelay/commit/a43a5a291901c0f2fcb9a7a8bd99bc0ffb93071f))
* keep delegated workflows advancing automatically ([#53](https://github.com/krasnoperov/patchrelay/issues/53)) ([a2d0983](https://github.com/krasnoperov/patchrelay/commit/a2d098344064aba1c9001d0480e9ed855b36ead9))
* keep HTTP CLI commands free of sqlite imports ([8b221a6](https://github.com/krasnoperov/patchrelay/commit/8b221a6e20e95fcef16511b0ae80de97254e0510))
* keep reconciling active runs after startup ([889365e](https://github.com/krasnoperov/patchrelay/commit/889365e32c731c7f90f47817cad5f2841e2ee3e2))
* normalize release-please automation ([#31](https://github.com/krasnoperov/patchrelay/issues/31)) ([6a415f8](https://github.com/krasnoperov/patchrelay/commit/6a415f8d967cfa1a83bb671c69de61002bfb6ade))
* prefer bundled build metadata ([9e4cadf](https://github.com/krasnoperov/patchrelay/commit/9e4cadfaefb8c64501a0d19b79f689bbc7899d32))
* preserve forward workflow progression across stage handoffs ([#55](https://github.com/krasnoperov/patchrelay/issues/55)) ([5175f2e](https://github.com/krasnoperov/patchrelay/commit/5175f2ebd312934ff7fe66abbba16141ca5147e5))
* preserve queued stage receipts across follow-up webhooks ([#59](https://github.com/krasnoperov/patchrelay/issues/59)) ([8dbdfc0](https://github.com/krasnoperov/patchrelay/commit/8dbdfc0dfe42e52d6e4ddd0140524d27b7cfc4da))
* recover interrupted codex runs after restart ([#30](https://github.com/krasnoperov/patchrelay/issues/30)) ([38d7ddd](https://github.com/krasnoperov/patchrelay/commit/38d7dddbc3dfbc51ae5870ff801f8ff9002a149d))
* release stale active runs after terminal linear state ([#61](https://github.com/krasnoperov/patchrelay/issues/61)) ([f941cbe](https://github.com/krasnoperov/patchrelay/commit/f941cbe9341e82e5730aff49f0210dfa5d05ac46))
* rename CLI flags from stage terminology to run terminology ([#72](https://github.com/krasnoperov/patchrelay/issues/72)) ([ab1383f](https://github.com/krasnoperov/patchrelay/commit/ab1383fd117cd7635c9174f089e3370ce4deca24))
* require native Linear sessions to launch workflows ([452970f](https://github.com/krasnoperov/patchrelay/commit/452970f73bf9232a2dc3900f466baabb30bd7765))
* reuse owned worktrees across root drift ([7cfa308](https://github.com/krasnoperov/patchrelay/commit/7cfa308215069d0450f1154c7ab029cbadc536c6))
* skip interrupted recovery after terminal linear state ([#63](https://github.com/krasnoperov/patchrelay/issues/63)) ([d85783a](https://github.com/krasnoperov/patchrelay/commit/d85783a7a88d5e29544844d3e2ad874f86c865ae))
* skip stale release-pr merge watchers ([#35](https://github.com/krasnoperov/patchrelay/issues/35)) ([7104ccc](https://github.com/krasnoperov/patchrelay/commit/7104ccc8fbe269c07032e203600e1932aa64328b))
* tighten delegated Linear session delivery ([#45](https://github.com/krasnoperov/patchrelay/issues/45)) ([042bb58](https://github.com/krasnoperov/patchrelay/commit/042bb585d68debcf2937139bccd3c7ce1373b6dd))
* time out background reconciliation stalls ([#67](https://github.com/krasnoperov/patchrelay/issues/67)) ([b279acc](https://github.com/krasnoperov/patchrelay/commit/b279accac0ea052acfda195d0b9ac10bcf306606))
* time out hung codex app-server requests ([#65](https://github.com/krasnoperov/patchrelay/issues/65)) ([c2d5d23](https://github.com/krasnoperov/patchrelay/commit/c2d5d234edcf79342af7110d708b48d03e7969d6))
* use default release app permissions ([#33](https://github.com/krasnoperov/patchrelay/issues/33)) ([b2b3ad6](https://github.com/krasnoperov/patchrelay/commit/b2b3ad69a41621c748810546963faea0278c5c03))
* use native Linear agent sessions for delegated workflow status ([#37](https://github.com/krasnoperov/patchrelay/issues/37)) ([06c1783](https://github.com/krasnoperov/patchrelay/commit/06c1783d2d2bf1a164807922d7db18ec1fd41797))
* verify database schema health in doctor ([6c7221d](https://github.com/krasnoperov/patchrelay/commit/6c7221db17b8bf09e8b5108d98a345586eeaf923))

## [0.9.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.9.1...patchrelay-v0.9.2) (2026-03-22)


### Bug Fixes

* consolidate CI into single job, support --version flag ([#74](https://github.com/krasnoperov/patchrelay/issues/74)) ([a553cad](https://github.com/krasnoperov/patchrelay/commit/a553cad7abc48652196f02ddc115443d890ae09e))

## [0.9.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.9.0...patchrelay-v0.9.1) (2026-03-22)


### Bug Fixes

* rename CLI flags from stage terminology to run terminology ([#72](https://github.com/krasnoperov/patchrelay/issues/72)) ([ab1383f](https://github.com/krasnoperov/patchrelay/commit/ab1383fd117cd7635c9174f089e3370ce4deca24))

## [0.9.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.9...patchrelay-v0.9.0) (2026-03-22)


### Features

* factory control plane with reactive GitHub loops ([#70](https://github.com/krasnoperov/patchrelay/issues/70)) ([04e5cbd](https://github.com/krasnoperov/patchrelay/commit/04e5cbdc9f66f053853cbe2475c9e50a691d830b))

## [0.8.9](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.8...patchrelay-v0.8.9) (2026-03-19)


### Bug Fixes

* time out background reconciliation stalls ([#67](https://github.com/krasnoperov/patchrelay/issues/67)) ([b279acc](https://github.com/krasnoperov/patchrelay/commit/b279accac0ea052acfda195d0b9ac10bcf306606))

## [0.8.8](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.7...patchrelay-v0.8.8) (2026-03-19)


### Bug Fixes

* time out hung codex app-server requests ([#65](https://github.com/krasnoperov/patchrelay/issues/65)) ([c2d5d23](https://github.com/krasnoperov/patchrelay/commit/c2d5d234edcf79342af7110d708b48d03e7969d6))

## [0.8.7](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.6...patchrelay-v0.8.7) (2026-03-19)


### Bug Fixes

* skip interrupted recovery after terminal linear state ([#63](https://github.com/krasnoperov/patchrelay/issues/63)) ([d85783a](https://github.com/krasnoperov/patchrelay/commit/d85783a7a88d5e29544844d3e2ad874f86c865ae))

## [0.8.6](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.5...patchrelay-v0.8.6) (2026-03-19)


### Bug Fixes

* release stale active runs after terminal linear state ([#61](https://github.com/krasnoperov/patchrelay/issues/61)) ([f941cbe](https://github.com/krasnoperov/patchrelay/commit/f941cbe9341e82e5730aff49f0210dfa5d05ac46))

## [0.8.5](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.4...patchrelay-v0.8.5) (2026-03-19)


### Bug Fixes

* preserve queued stage receipts across follow-up webhooks ([#59](https://github.com/krasnoperov/patchrelay/issues/59)) ([8dbdfc0](https://github.com/krasnoperov/patchrelay/commit/8dbdfc0dfe42e52d6e4ddd0140524d27b7cfc4da))

## [0.8.4](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.3...patchrelay-v0.8.4) (2026-03-19)


### Bug Fixes

* honor live terminal Linear states over stale stage work ([#57](https://github.com/krasnoperov/patchrelay/issues/57)) ([b1057fc](https://github.com/krasnoperov/patchrelay/commit/b1057fc249748b4ffca7de87a67c7d3e83162523))

## [0.8.3](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.2...patchrelay-v0.8.3) (2026-03-18)


### Bug Fixes

* preserve forward workflow progression across stage handoffs ([#55](https://github.com/krasnoperov/patchrelay/issues/55)) ([5175f2e](https://github.com/krasnoperov/patchrelay/commit/5175f2ebd312934ff7fe66abbba16141ca5147e5))

## [0.8.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.1...patchrelay-v0.8.2) (2026-03-18)


### Bug Fixes

* keep delegated workflows advancing automatically ([#53](https://github.com/krasnoperov/patchrelay/issues/53)) ([a2d0983](https://github.com/krasnoperov/patchrelay/commit/a2d098344064aba1c9001d0480e9ed855b36ead9))

## [0.8.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.8.0...patchrelay-v0.8.1) (2026-03-18)


### Bug Fixes

* keep reconciling active runs after startup ([889365e](https://github.com/krasnoperov/patchrelay/commit/889365e32c731c7f90f47817cad5f2841e2ee3e2))

## [0.8.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.10...patchrelay-v0.8.0) (2026-03-18)


### Features

* add repo-local workflows and workflow timeline ([6a3d3a4](https://github.com/krasnoperov/patchrelay/commit/6a3d3a4e8036ed783a4a22a37332242c5d73ae89))

## [0.7.10](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.9...patchrelay-v0.7.10) (2026-03-17)


### Bug Fixes

* tighten delegated Linear session delivery ([#45](https://github.com/krasnoperov/patchrelay/issues/45)) ([042bb58](https://github.com/krasnoperov/patchrelay/commit/042bb585d68debcf2937139bccd3c7ce1373b6dd))

## [0.7.9](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.8...patchrelay-v0.7.9) (2026-03-17)


### Bug Fixes

* hydrate sparse Linear agent session issues ([a43a5a2](https://github.com/krasnoperov/patchrelay/commit/a43a5a291901c0f2fcb9a7a8bd99bc0ffb93071f))

## [0.7.8](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.7.7...patchrelay-v0.7.8) (2026-03-17)


### Bug Fixes

* accept delegated Linear agent sessions natively ([325643b](https://github.com/krasnoperov/patchrelay/commit/325643bb13aeb3110bc7bbe7b3f4fc353f7a7e4e))

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
