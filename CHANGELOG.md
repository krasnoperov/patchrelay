# Changelog

## [0.25.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.24.2...patchrelay-v0.25.0) (2026-03-26)


### Features

* show run report details in history view ([#184](https://github.com/krasnoperov/patchrelay/issues/184)) ([2720154](https://github.com/krasnoperov/patchrelay/commit/272015413d7b03325d681ede7281feb9201bfef1))

## [0.24.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.24.1...patchrelay-v0.24.2) (2026-03-26)


### Bug Fixes

* show all runs in history view, no truncation ([#182](https://github.com/krasnoperov/patchrelay/issues/182)) ([c9e6690](https://github.com/krasnoperov/patchrelay/commit/c9e6690dcc92608cd43371b97453adc46a483dd7))

## [0.24.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.24.0...patchrelay-v0.24.1) (2026-03-26)


### Bug Fixes

* history view handles many runs and missing feed events ([#180](https://github.com/krasnoperov/patchrelay/issues/180)) ([8b0c1c6](https://github.com/krasnoperov/patchrelay/commit/8b0c1c6de1c06757865f49c4112a97b2e9297099))

## [0.24.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.23.5...patchrelay-v0.24.0) (2026-03-26)


### Features

* add state history view to watch TUI ([#178](https://github.com/krasnoperov/patchrelay/issues/178)) ([a522fc8](https://github.com/krasnoperov/patchrelay/commit/a522fc8be27bfb51b464af0874fb80c3e4c0887c))

## [0.23.5](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.23.4...patchrelay-v0.23.5) (2026-03-26)


### Bug Fixes

* terminal state guards, zombie recovery backoff, worktree fork point ([#176](https://github.com/krasnoperov/patchrelay/issues/176)) ([c3d628a](https://github.com/krasnoperov/patchrelay/commit/c3d628adf8f89c7dee5285297c2e70e63a18649f))

## [0.23.4](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.23.3...patchrelay-v0.23.4) (2026-03-26)


### Bug Fixes

* complete feed event coverage for all state transitions ([#173](https://github.com/krasnoperov/patchrelay/issues/173)) ([6596305](https://github.com/krasnoperov/patchrelay/commit/659630595b0529bd3d9d0a7cfceb13419009d344))

## [0.23.3](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.23.2...patchrelay-v0.23.3) (2026-03-26)


### Bug Fixes

* publish feed events on reconciliation state transitions ([#171](https://github.com/krasnoperov/patchrelay/issues/171)) ([b872702](https://github.com/krasnoperov/patchrelay/commit/b8727025f1580ed17c8ad8dbaa5d755423c9cd73))

## [0.23.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.23.1...patchrelay-v0.23.2) (2026-03-26)


### Bug Fixes

* clearer state labels — 'review fix' not 'changes', 'paused' not 'input' ([#168](https://github.com/krasnoperov/patchrelay/issues/168)) ([0159bff](https://github.com/krasnoperov/patchrelay/commit/0159bff622e8b8d78e24169ce3d0b06860e16ce4))
* release active run on escalation ([#170](https://github.com/krasnoperov/patchrelay/issues/170)) ([5c08462](https://github.com/krasnoperov/patchrelay/commit/5c0846203b1a69172a07ac5acef18de56f8f951b))

## [0.23.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.23.0...patchrelay-v0.23.1) (2026-03-26)


### Bug Fixes

* hide run status symbol for terminal states ([#166](https://github.com/krasnoperov/patchrelay/issues/166)) ([459092b](https://github.com/krasnoperov/patchrelay/commit/459092b2a4d615fad83f4adc14bd7c10ebd3bba7))

## [0.23.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.22.0...patchrelay-v0.23.0) (2026-03-26)


### Features

* add operator feed and harden CLI flows ([#14](https://github.com/krasnoperov/patchrelay/issues/14)) ([33193e9](https://github.com/krasnoperov/patchrelay/commit/33193e99ef75566772a62f8019ce382a2203082a))
* add public ingress configuration ([aa365d6](https://github.com/krasnoperov/patchrelay/commit/aa365d6a70c3f3d2de7cfe58b2316f229cae9ae6))
* add repo-local workflows and workflow timeline ([6a3d3a4](https://github.com/krasnoperov/patchrelay/commit/6a3d3a4e8036ed783a4a22a37332242c5d73ae89))
* add version CLI command ([66447c7](https://github.com/krasnoperov/patchrelay/commit/66447c7bdca8764794788d86aa1727545e3ba1e3))
* built-in merge queue for PatchRelay-managed PRs ([#93](https://github.com/krasnoperov/patchrelay/issues/93)) ([#93](https://github.com/krasnoperov/patchrelay/issues/93)) ([509884e](https://github.com/krasnoperov/patchrelay/commit/509884e648f4d597abf854c59d9175c91a15db72))
* expanded reconciliation, check classification, display alignment ([#137](https://github.com/krasnoperov/patchrelay/issues/137)) ([9d890d4](https://github.com/krasnoperov/patchrelay/commit/9d890d48aa8a8c5daadc465ef29df257c067d55d))
* factory control plane with reactive GitHub loops ([#70](https://github.com/krasnoperov/patchrelay/issues/70)) ([04e5cbd](https://github.com/krasnoperov/patchrelay/commit/04e5cbdc9f66f053853cbe2475c9e50a691d830b))
* GitHub App bot identity and provider-agnostic secrets ([#95](https://github.com/krasnoperov/patchrelay/issues/95)) ([#95](https://github.com/krasnoperov/patchrelay/issues/95)) ([a8fcbb0](https://github.com/krasnoperov/patchrelay/commit/a8fcbb0df5b6125aa433d5d7b6a57613fe13a864))
* Linear progress fix, stop command, comment-triggered runs ([#157](https://github.com/krasnoperov/patchrelay/issues/157)) ([c2abed3](https://github.com/krasnoperov/patchrelay/commit/c2abed39447e48e26556e9ebe1471b02f0a75d27))
* patchrelay watch — real-time TUI dashboard ([#118](https://github.com/krasnoperov/patchrelay/issues/118)) ([7c5b108](https://github.com/krasnoperov/patchrelay/commit/7c5b108e010310211a8c6ed8270a62fc2e7ccf0e))
* persist issue session handoff history for open ([45e6bb6](https://github.com/krasnoperov/patchrelay/commit/45e6bb6ccbfd822d12487e3ee7d52c0af7e69105))
* Phase 3 polish — report fallback, titles, relative times, filters ([#121](https://github.com/krasnoperov/patchrelay/issues/121)) ([f201d1c](https://github.com/krasnoperov/patchrelay/commit/f201d1cf1d513c1344e8133cbebb0d5999a20692))
* refresh cli help and lazy-load sqlite ([ddc22a1](https://github.com/krasnoperov/patchrelay/commit/ddc22a1cfd89ea9b0e93776902efd6a31d89ae4a))
* **runtime:** simplify health and zmx session naming ([602ad79](https://github.com/krasnoperov/patchrelay/commit/602ad79815b0ebeeed278db144e1137d69f4357c))
* separate mention sessions from delegated workflows ([fa8a4a9](https://github.com/krasnoperov/patchrelay/commit/fa8a4a9ff89b32a5896e5c8aefd766b512923aad))
* separate workflow coordination from query and cli dispatch ([e40a046](https://github.com/krasnoperov/patchrelay/commit/e40a046e95869e8f064a7a4b4bcd0e9c18e5c8f6))
* Static scrollback, compact status, periodic refresh ([#163](https://github.com/krasnoperov/patchrelay/issues/163)) ([40b66ba](https://github.com/krasnoperov/patchrelay/commit/40b66ba3886ac9e641a5766ff35b34e7b74e6628))
* unified lifecycle timeline in watch detail view ([#131](https://github.com/krasnoperov/patchrelay/issues/131)) ([e890f3e](https://github.com/krasnoperov/patchrelay/commit/e890f3e09bcc42b60c0b3dd273cb66b0e767a5c1))
* user input — watch prompt, GitHub PR comment forwarding ([#139](https://github.com/krasnoperov/patchrelay/issues/139)) ([cb4cd4b](https://github.com/krasnoperov/patchrelay/commit/cb4cd4bb3f6758f818d3633b0136dccd6059cf99))
* watch TUI — token usage, diff summary, follow mode ([#127](https://github.com/krasnoperov/patchrelay/issues/127)) ([e3f05a5](https://github.com/krasnoperov/patchrelay/commit/e3f05a59826a36c1b63398896f5d6c2a0c88727f))
* watch TUI mission-control enhancements and Linear context enrichment ([#135](https://github.com/krasnoperov/patchrelay/issues/135)) ([977861b](https://github.com/krasnoperov/patchrelay/commit/977861b46176207fa2d1ba73d5f299b449746a7c))
* watch TUI operational parity with Linear observability ([#129](https://github.com/krasnoperov/patchrelay/issues/129)) ([b5b7652](https://github.com/krasnoperov/patchrelay/commit/b5b7652ce1d7fe87a396c1bfd348121d4305771b))
* **webhooks:** build status-driven patchrelay v1 ([ad1945a](https://github.com/krasnoperov/patchrelay/commit/ad1945a353afb77d45f5abed1c7297dbea76c69d))


### Bug Fixes

* accept delegated Linear agent sessions natively ([325643b](https://github.com/krasnoperov/patchrelay/commit/325643bb13aeb3110bc7bbe7b3f4fc353f7a7e4e))
* align release app token permissions ([#32](https://github.com/krasnoperov/patchrelay/issues/32)) ([4b89875](https://github.com/krasnoperov/patchrelay/commit/4b89875f41257acc98a5fabded29137a514902f1))
* complete CI pre-merge coverage ([39383f3](https://github.com/krasnoperov/patchrelay/commit/39383f307a9bb1b4cbafe1650b3c794cfbb53c3a))
* consistent item prefix spacing in timeline ([#153](https://github.com/krasnoperov/patchrelay/issues/153)) ([ec47161](https://github.com/krasnoperov/patchrelay/commit/ec47161267928922cb2d2579dde4db17c1c3ec76))
* consolidate CI into single job, support --version flag ([#74](https://github.com/krasnoperov/patchrelay/issues/74)) ([a553cad](https://github.com/krasnoperov/patchrelay/commit/a553cad7abc48652196f02ddc115443d890ae09e))
* crash-proof Linear auth and add connectivity to readiness probe ([#109](https://github.com/krasnoperov/patchrelay/issues/109)) ([23a323d](https://github.com/krasnoperov/patchrelay/commit/23a323d02a25da58a417fcb1a0663266f044f5fc))
* declare experimentalApi capability in initialize handshake ([#145](https://github.com/krasnoperov/patchrelay/issues/145)) ([3883483](https://github.com/krasnoperov/patchrelay/commit/38834835588c58b38239961043c63e2fd4f37df9))
* enqueue Start workflows from issue creation by default ([#28](https://github.com/krasnoperov/patchrelay/issues/28)) ([25edf2b](https://github.com/krasnoperov/patchrelay/commit/25edf2bd5e4dc3eecc4343c8f21aa59045242c1d))
* escalate Linear API failures to warn level and operator feed ([#115](https://github.com/krasnoperov/patchrelay/issues/115)) ([5d4649d](https://github.com/krasnoperov/patchrelay/commit/5d4649df95c7b322fc7db172bacbe49e4e19cc8d))
* follow OFF shows full timeline, follow ON tails to screen height ([#155](https://github.com/krasnoperov/patchrelay/issues/155)) ([9344b3f](https://github.com/krasnoperov/patchrelay/commit/9344b3fec3cbace1b89f18880bf5494ad0bf5802))
* full commands, sync codex plan to Linear ([#161](https://github.com/krasnoperov/patchrelay/issues/161)) ([3bfa748](https://github.com/krasnoperov/patchrelay/commit/3bfa7489abd835a15a915675c7583a83978fc10c))
* graceful shutdown and idle issue self-healing ([#113](https://github.com/krasnoperov/patchrelay/issues/113)) ([8864f75](https://github.com/krasnoperov/patchrelay/commit/8864f75f69db517d396b96fb64398dab423aa0f7))
* handle late review in awaiting_queue and stale thread fallback ([#97](https://github.com/krasnoperov/patchrelay/issues/97)) ([#97](https://github.com/krasnoperov/patchrelay/issues/97)) ([35e57ef](https://github.com/krasnoperov/patchrelay/commit/35e57efd2d58d75753d208a54ab32878d26373db))
* honor live terminal Linear states over stale stage work ([#57](https://github.com/krasnoperov/patchrelay/issues/57)) ([b1057fc](https://github.com/krasnoperov/patchrelay/commit/b1057fc249748b4ffca7de87a67c7d3e83162523))
* hydrate sparse Linear agent session issues ([a43a5a2](https://github.com/krasnoperov/patchrelay/commit/a43a5a291901c0f2fcb9a7a8bd99bc0ffb93071f))
* issue routes on loopback, interrupt budgets, smart retry ([#151](https://github.com/krasnoperov/patchrelay/issues/151)) ([798a97f](https://github.com/krasnoperov/patchrelay/commit/798a97fa23712677ef353376541ddefaf2672a24))
* keep delegated workflows advancing automatically ([#53](https://github.com/krasnoperov/patchrelay/issues/53)) ([a2d0983](https://github.com/krasnoperov/patchrelay/commit/a2d098344064aba1c9001d0480e9ed855b36ead9))
* keep HTTP CLI commands free of sqlite imports ([8b221a6](https://github.com/krasnoperov/patchrelay/commit/8b221a6e20e95fcef16511b0ae80de97254e0510))
* keep reconciling active runs after startup ([889365e](https://github.com/krasnoperov/patchrelay/commit/889365e32c731c7f90f47817cad5f2841e2ee3e2))
* mark GitHub dedupe-only webhooks as processed, clean up stale backlog ([#83](https://github.com/krasnoperov/patchrelay/issues/83)) ([5d17314](https://github.com/krasnoperov/patchrelay/commit/5d173143238ba06034e409d590041b150e9e481f))
* migrate to system service and service-aware doctor ([#123](https://github.com/krasnoperov/patchrelay/issues/123)) ([21e9780](https://github.com/krasnoperov/patchrelay/commit/21e9780c07bb37552a6d97ae8482cad6789bbfb0))
* normalize release-please automation ([#31](https://github.com/krasnoperov/patchrelay/issues/31)) ([6a415f8](https://github.com/krasnoperov/patchrelay/commit/6a415f8d967cfa1a83bb671c69de61002bfb6ade))
* polish run behavior from USE-67 session observations ([#90](https://github.com/krasnoperov/patchrelay/issues/90)) ([16dabb8](https://github.com/krasnoperov/patchrelay/commit/16dabb8b0f9b3daf4d88bcb56ab9327b25e956f3))
* prefer bundled build metadata ([9e4cadf](https://github.com/krasnoperov/patchrelay/commit/9e4cadfaefb8c64501a0d19b79f689bbc7899d32))
* preserve forward workflow progression across stage handoffs ([#55](https://github.com/krasnoperov/patchrelay/issues/55)) ([5175f2e](https://github.com/krasnoperov/patchrelay/commit/5175f2ebd312934ff7fe66abbba16141ca5147e5))
* preserve queued stage receipts across follow-up webhooks ([#59](https://github.com/krasnoperov/patchrelay/issues/59)) ([8dbdfc0](https://github.com/krasnoperov/patchrelay/commit/8dbdfc0dfe42e52d6e4ddd0140524d27b7cfc4da))
* prevent check event flickering, stale issue reads, and aggressive pr_closed ([#88](https://github.com/krasnoperov/patchrelay/issues/88)) ([01ce7ad](https://github.com/krasnoperov/patchrelay/commit/01ce7adb8786fa0779317760c2ab00731451a68f))
* prompt input improvements — visibility, queuing, cross-publish ([#141](https://github.com/krasnoperov/patchrelay/issues/141)) ([f14c61f](https://github.com/krasnoperov/patchrelay/commit/f14c61f547ef267e5fe52e499c35f7ddec13d22d))
* reconciliation picks up ready issues without restart ([#111](https://github.com/krasnoperov/patchrelay/issues/111)) ([44dd17b](https://github.com/krasnoperov/patchrelay/commit/44dd17b37fc0ab049378380975bbcbdc9656a7c3))
* recover interrupted codex runs after restart ([#30](https://github.com/krasnoperov/patchrelay/issues/30)) ([38d7ddd](https://github.com/krasnoperov/patchrelay/commit/38d7dddbc3dfbc51ae5870ff801f8ff9002a149d))
* refresh workspace identity on connect reuse, show versions in doctor ([#81](https://github.com/krasnoperov/patchrelay/issues/81)) ([0909fda](https://github.com/krasnoperov/patchrelay/commit/0909fdae7746af340605c7d596c05e940d2e0521))
* release stale active runs after terminal linear state ([#61](https://github.com/krasnoperov/patchrelay/issues/61)) ([f941cbe](https://github.com/krasnoperov/patchrelay/commit/f941cbe9341e82e5730aff49f0210dfa5d05ac46))
* remove non-actionable webhook queue warning from doctor ([#85](https://github.com/krasnoperov/patchrelay/issues/85)) ([606c8b3](https://github.com/krasnoperov/patchrelay/commit/606c8b3632238594137fb3496312161a08b2e55c))
* rename CLI flags from stage terminology to run terminology ([#72](https://github.com/krasnoperov/patchrelay/issues/72)) ([ab1383f](https://github.com/krasnoperov/patchrelay/commit/ab1383fd117cd7635c9174f089e3370ce4deca24))
* require native Linear sessions to launch workflows ([452970f](https://github.com/krasnoperov/patchrelay/commit/452970f73bf9232a2dc3900f466baabb30bd7765))
* retry with fresh thread on stale thread during startTurn ([#99](https://github.com/krasnoperov/patchrelay/issues/99)) ([a9375bf](https://github.com/krasnoperov/patchrelay/commit/a9375bf47cd5c09a5015fc3bfedbec16025e7825))
* reuse owned worktrees across root drift ([7cfa308](https://github.com/krasnoperov/patchrelay/commit/7cfa308215069d0450f1154c7ab029cbadc536c6))
* review_approved from changes_requested transitions to awaiting_queue ([#101](https://github.com/krasnoperov/patchrelay/issues/101)) ([fd91252](https://github.com/krasnoperov/patchrelay/commit/fd912527d4a060990078ef9ea93acc2bb094e58c))
* self-healing for zombie runs, crash-proof Linear calls, startup auth check ([#106](https://github.com/krasnoperov/patchrelay/issues/106)) ([38b5f3f](https://github.com/krasnoperov/patchrelay/commit/38b5f3ff93b5443df51ad2dac48285127ce138e2))
* show project routing in patchrelay installations output ([#79](https://github.com/krasnoperov/patchrelay/issues/79)) ([fac389d](https://github.com/krasnoperov/patchrelay/commit/fac389d4e83b506f0b55ba60f7ad70aaec73ac69))
* show retry/prompt status feedback in watch TUI ([#147](https://github.com/krasnoperov/patchrelay/issues/147)) ([87b0258](https://github.com/krasnoperov/patchrelay/commit/87b025863944b7c51a88100aceb4f16a3f5e43e7))
* skip interrupted recovery after terminal linear state ([#63](https://github.com/krasnoperov/patchrelay/issues/63)) ([d85783a](https://github.com/krasnoperov/patchrelay/commit/d85783a7a88d5e29544844d3e2ad874f86c865ae))
* skip service readiness check during serve startup preflight ([#125](https://github.com/krasnoperov/patchrelay/issues/125)) ([d086d07](https://github.com/krasnoperov/patchrelay/commit/d086d077ce04a21979d68af6dfd8878461eccebe))
* skip stale release-pr merge watchers ([#35](https://github.com/krasnoperov/patchrelay/issues/35)) ([7104ccc](https://github.com/krasnoperov/patchrelay/commit/7104ccc8fbe269c07032e203600e1932aa64328b))
* state machine hardening — terminal states, budgets, reconciliation ([#133](https://github.com/krasnoperov/patchrelay/issues/133)) ([7e93c29](https://github.com/krasnoperov/patchrelay/commit/7e93c29d3eded348aae826a2e5751d4c604dbc8c))
* strip bash wrapper from command display, hide exit:0 ([#159](https://github.com/krasnoperov/patchrelay/issues/159)) ([083f166](https://github.com/krasnoperov/patchrelay/commit/083f166e461789c74ecc255e15788fef3588a50e))
* tighten delegated Linear session delivery ([#45](https://github.com/krasnoperov/patchrelay/issues/45)) ([042bb58](https://github.com/krasnoperov/patchrelay/commit/042bb585d68debcf2937139bccd3c7ce1373b6dd))
* time out background reconciliation stalls ([#67](https://github.com/krasnoperov/patchrelay/issues/67)) ([b279acc](https://github.com/krasnoperov/patchrelay/commit/b279accac0ea052acfda195d0b9ac10bcf306606))
* time out hung codex app-server requests ([#65](https://github.com/krasnoperov/patchrelay/issues/65)) ([c2d5d23](https://github.com/krasnoperov/patchrelay/commit/c2d5d234edcf79342af7110d708b48d03e7969d6))
* trigger release for rule-based state machine refactor ([#104](https://github.com/krasnoperov/patchrelay/issues/104)) ([79a7a17](https://github.com/krasnoperov/patchrelay/commit/79a7a17c612a2832b25191af5ff9252deee2b013))
* TUI layout polish — remove borders, compact statuses, responsive ([#143](https://github.com/krasnoperov/patchrelay/issues/143)) ([2b39130](https://github.com/krasnoperov/patchrelay/commit/2b391300c11379ebf1815f726527d1383342f83a))
* TUI rendering — remove sidebar, viewport scrolling, full messages ([#149](https://github.com/krasnoperov/patchrelay/issues/149)) ([77e7f84](https://github.com/krasnoperov/patchrelay/commit/77e7f84f5966c42cac7c74ed0fdbb2a229bfaa1c))
* use default release app permissions ([#33](https://github.com/krasnoperov/patchrelay/issues/33)) ([b2b3ad6](https://github.com/krasnoperov/patchrelay/commit/b2b3ad69a41621c748810546963faea0278c5c03))
* use Linear organization name for workspace identity, not first team name ([#77](https://github.com/krasnoperov/patchrelay/issues/77)) ([85abd92](https://github.com/krasnoperov/patchrelay/commit/85abd92bc01b1bb71173442d7d65252525331fe0))
* use native Linear agent sessions for delegated workflow status ([#37](https://github.com/krasnoperov/patchrelay/issues/37)) ([06c1783](https://github.com/krasnoperov/patchrelay/commit/06c1783d2d2bf1a164807922d7db18ec1fd41797))
* verify database schema health in doctor ([6c7221d](https://github.com/krasnoperov/patchrelay/commit/6c7221db17b8bf09e8b5108d98a345586eeaf923))

## [0.22.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.21.2...patchrelay-v0.22.0) (2026-03-26)


### Features

* Static scrollback, compact status, periodic refresh ([#163](https://github.com/krasnoperov/patchrelay/issues/163)) ([40b66ba](https://github.com/krasnoperov/patchrelay/commit/40b66ba3886ac9e641a5766ff35b34e7b74e6628))

## [0.21.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.21.1...patchrelay-v0.21.2) (2026-03-26)


### Bug Fixes

* full commands, sync codex plan to Linear ([#161](https://github.com/krasnoperov/patchrelay/issues/161)) ([3bfa748](https://github.com/krasnoperov/patchrelay/commit/3bfa7489abd835a15a915675c7583a83978fc10c))

## [0.21.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.21.0...patchrelay-v0.21.1) (2026-03-26)


### Bug Fixes

* strip bash wrapper from command display, hide exit:0 ([#159](https://github.com/krasnoperov/patchrelay/issues/159)) ([083f166](https://github.com/krasnoperov/patchrelay/commit/083f166e461789c74ecc255e15788fef3588a50e))

## [0.21.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.20.8...patchrelay-v0.21.0) (2026-03-26)


### Features

* Linear progress fix, stop command, comment-triggered runs ([#157](https://github.com/krasnoperov/patchrelay/issues/157)) ([c2abed3](https://github.com/krasnoperov/patchrelay/commit/c2abed39447e48e26556e9ebe1471b02f0a75d27))

## [0.20.8](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.20.7...patchrelay-v0.20.8) (2026-03-26)


### Bug Fixes

* follow OFF shows full timeline, follow ON tails to screen height ([#155](https://github.com/krasnoperov/patchrelay/issues/155)) ([9344b3f](https://github.com/krasnoperov/patchrelay/commit/9344b3fec3cbace1b89f18880bf5494ad0bf5802))

## [0.20.7](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.20.6...patchrelay-v0.20.7) (2026-03-26)


### Bug Fixes

* consistent item prefix spacing in timeline ([#153](https://github.com/krasnoperov/patchrelay/issues/153)) ([ec47161](https://github.com/krasnoperov/patchrelay/commit/ec47161267928922cb2d2579dde4db17c1c3ec76))

## [0.20.6](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.20.5...patchrelay-v0.20.6) (2026-03-26)


### Bug Fixes

* issue routes on loopback, interrupt budgets, smart retry ([#151](https://github.com/krasnoperov/patchrelay/issues/151)) ([798a97f](https://github.com/krasnoperov/patchrelay/commit/798a97fa23712677ef353376541ddefaf2672a24))

## [0.20.5](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.20.4...patchrelay-v0.20.5) (2026-03-25)


### Bug Fixes

* TUI rendering — remove sidebar, viewport scrolling, full messages ([#149](https://github.com/krasnoperov/patchrelay/issues/149)) ([77e7f84](https://github.com/krasnoperov/patchrelay/commit/77e7f84f5966c42cac7c74ed0fdbb2a229bfaa1c))

## [0.20.4](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.20.3...patchrelay-v0.20.4) (2026-03-25)


### Bug Fixes

* show retry/prompt status feedback in watch TUI ([#147](https://github.com/krasnoperov/patchrelay/issues/147)) ([87b0258](https://github.com/krasnoperov/patchrelay/commit/87b025863944b7c51a88100aceb4f16a3f5e43e7))

## [0.20.3](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.20.2...patchrelay-v0.20.3) (2026-03-25)


### Bug Fixes

* declare experimentalApi capability in initialize handshake ([#145](https://github.com/krasnoperov/patchrelay/issues/145)) ([3883483](https://github.com/krasnoperov/patchrelay/commit/38834835588c58b38239961043c63e2fd4f37df9))

## [0.20.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.20.1...patchrelay-v0.20.2) (2026-03-25)


### Bug Fixes

* TUI layout polish — remove borders, compact statuses, responsive ([#143](https://github.com/krasnoperov/patchrelay/issues/143)) ([2b39130](https://github.com/krasnoperov/patchrelay/commit/2b391300c11379ebf1815f726527d1383342f83a))

## [0.20.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.20.0...patchrelay-v0.20.1) (2026-03-25)


### Bug Fixes

* prompt input improvements — visibility, queuing, cross-publish ([#141](https://github.com/krasnoperov/patchrelay/issues/141)) ([f14c61f](https://github.com/krasnoperov/patchrelay/commit/f14c61f547ef267e5fe52e499c35f7ddec13d22d))

## [0.20.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.19.0...patchrelay-v0.20.0) (2026-03-25)


### Features

* user input — watch prompt, GitHub PR comment forwarding ([#139](https://github.com/krasnoperov/patchrelay/issues/139)) ([cb4cd4b](https://github.com/krasnoperov/patchrelay/commit/cb4cd4bb3f6758f818d3633b0136dccd6059cf99))

## [0.19.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.18.0...patchrelay-v0.19.0) (2026-03-25)


### Features

* expanded reconciliation, check classification, display alignment ([#137](https://github.com/krasnoperov/patchrelay/issues/137)) ([9d890d4](https://github.com/krasnoperov/patchrelay/commit/9d890d48aa8a8c5daadc465ef29df257c067d55d))

## [0.18.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.17.1...patchrelay-v0.18.0) (2026-03-25)


### Features

* watch TUI mission-control enhancements and Linear context enrichment ([#135](https://github.com/krasnoperov/patchrelay/issues/135)) ([977861b](https://github.com/krasnoperov/patchrelay/commit/977861b46176207fa2d1ba73d5f299b449746a7c))

## [0.17.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.17.0...patchrelay-v0.17.1) (2026-03-25)


### Bug Fixes

* state machine hardening — terminal states, budgets, reconciliation ([#133](https://github.com/krasnoperov/patchrelay/issues/133)) ([7e93c29](https://github.com/krasnoperov/patchrelay/commit/7e93c29d3eded348aae826a2e5751d4c604dbc8c))

## [0.17.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.16.0...patchrelay-v0.17.0) (2026-03-25)


### Features

* unified lifecycle timeline in watch detail view ([#131](https://github.com/krasnoperov/patchrelay/issues/131)) ([e890f3e](https://github.com/krasnoperov/patchrelay/commit/e890f3e09bcc42b60c0b3dd273cb66b0e767a5c1))

## [0.16.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.15.0...patchrelay-v0.16.0) (2026-03-25)


### Features

* watch TUI operational parity with Linear observability ([#129](https://github.com/krasnoperov/patchrelay/issues/129)) ([b5b7652](https://github.com/krasnoperov/patchrelay/commit/b5b7652ce1d7fe87a396c1bfd348121d4305771b))

## [0.15.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.14.2...patchrelay-v0.15.0) (2026-03-25)


### Features

* watch TUI — token usage, diff summary, follow mode ([#127](https://github.com/krasnoperov/patchrelay/issues/127)) ([e3f05a5](https://github.com/krasnoperov/patchrelay/commit/e3f05a59826a36c1b63398896f5d6c2a0c88727f))

## [0.14.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.14.1...patchrelay-v0.14.2) (2026-03-25)


### Bug Fixes

* skip service readiness check during serve startup preflight ([#125](https://github.com/krasnoperov/patchrelay/issues/125)) ([d086d07](https://github.com/krasnoperov/patchrelay/commit/d086d077ce04a21979d68af6dfd8878461eccebe))

## [0.14.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.14.0...patchrelay-v0.14.1) (2026-03-25)


### Bug Fixes

* migrate to system service and service-aware doctor ([#123](https://github.com/krasnoperov/patchrelay/issues/123)) ([21e9780](https://github.com/krasnoperov/patchrelay/commit/21e9780c07bb37552a6d97ae8482cad6789bbfb0))

## [0.14.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.13.0...patchrelay-v0.14.0) (2026-03-25)


### Features

* Phase 3 polish — report fallback, titles, relative times, filters ([#121](https://github.com/krasnoperov/patchrelay/issues/121)) ([f201d1c](https://github.com/krasnoperov/patchrelay/commit/f201d1cf1d513c1344e8133cbebb0d5999a20692))

## [0.13.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.9...patchrelay-v0.13.0) (2026-03-25)


### Features

* patchrelay watch — real-time TUI dashboard ([#118](https://github.com/krasnoperov/patchrelay/issues/118)) ([7c5b108](https://github.com/krasnoperov/patchrelay/commit/7c5b108e010310211a8c6ed8270a62fc2e7ccf0e))

## [0.12.9](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.8...patchrelay-v0.12.9) (2026-03-24)


### Bug Fixes

* escalate Linear API failures to warn level and operator feed ([#115](https://github.com/krasnoperov/patchrelay/issues/115)) ([5d4649d](https://github.com/krasnoperov/patchrelay/commit/5d4649df95c7b322fc7db172bacbe49e4e19cc8d))

## [0.12.8](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.7...patchrelay-v0.12.8) (2026-03-24)


### Bug Fixes

* graceful shutdown and idle issue self-healing ([#113](https://github.com/krasnoperov/patchrelay/issues/113)) ([8864f75](https://github.com/krasnoperov/patchrelay/commit/8864f75f69db517d396b96fb64398dab423aa0f7))

## [0.12.7](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.6...patchrelay-v0.12.7) (2026-03-24)


### Bug Fixes

* reconciliation picks up ready issues without restart ([#111](https://github.com/krasnoperov/patchrelay/issues/111)) ([44dd17b](https://github.com/krasnoperov/patchrelay/commit/44dd17b37fc0ab049378380975bbcbdc9656a7c3))

## [0.12.6](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.5...patchrelay-v0.12.6) (2026-03-24)


### Bug Fixes

* crash-proof Linear auth and add connectivity to readiness probe ([#109](https://github.com/krasnoperov/patchrelay/issues/109)) ([23a323d](https://github.com/krasnoperov/patchrelay/commit/23a323d02a25da58a417fcb1a0663266f044f5fc))

## [0.12.5](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.4...patchrelay-v0.12.5) (2026-03-24)


### Bug Fixes

* self-healing for zombie runs, crash-proof Linear calls, startup auth check ([#106](https://github.com/krasnoperov/patchrelay/issues/106)) ([38b5f3f](https://github.com/krasnoperov/patchrelay/commit/38b5f3ff93b5443df51ad2dac48285127ce138e2))

## [0.12.4](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.3...patchrelay-v0.12.4) (2026-03-24)


### Bug Fixes

* trigger release for rule-based state machine refactor ([#104](https://github.com/krasnoperov/patchrelay/issues/104)) ([79a7a17](https://github.com/krasnoperov/patchrelay/commit/79a7a17c612a2832b25191af5ff9252deee2b013))

## [0.12.3](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.2...patchrelay-v0.12.3) (2026-03-24)


### Bug Fixes

* review_approved from changes_requested transitions to awaiting_queue ([#101](https://github.com/krasnoperov/patchrelay/issues/101)) ([fd91252](https://github.com/krasnoperov/patchrelay/commit/fd912527d4a060990078ef9ea93acc2bb094e58c))

## [0.12.2](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.1...patchrelay-v0.12.2) (2026-03-24)


### Bug Fixes

* retry with fresh thread on stale thread during startTurn ([#99](https://github.com/krasnoperov/patchrelay/issues/99)) ([a9375bf](https://github.com/krasnoperov/patchrelay/commit/a9375bf47cd5c09a5015fc3bfedbec16025e7825))

## [0.12.1](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.12.0...patchrelay-v0.12.1) (2026-03-24)


### Bug Fixes

* handle late review in awaiting_queue and stale thread fallback ([#97](https://github.com/krasnoperov/patchrelay/issues/97)) ([#97](https://github.com/krasnoperov/patchrelay/issues/97)) ([35e57ef](https://github.com/krasnoperov/patchrelay/commit/35e57efd2d58d75753d208a54ab32878d26373db))

## [0.12.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.11.0...patchrelay-v0.12.0) (2026-03-24)


### Features

* GitHub App bot identity and provider-agnostic secrets ([#95](https://github.com/krasnoperov/patchrelay/issues/95)) ([#95](https://github.com/krasnoperov/patchrelay/issues/95)) ([a8fcbb0](https://github.com/krasnoperov/patchrelay/commit/a8fcbb0df5b6125aa433d5d7b6a57613fe13a864))

## [0.11.0](https://github.com/krasnoperov/patchrelay/compare/patchrelay-v0.10.7...patchrelay-v0.11.0) (2026-03-23)


### Features

* built-in merge queue for PatchRelay-managed PRs ([#93](https://github.com/krasnoperov/patchrelay/issues/93)) ([#93](https://github.com/krasnoperov/patchrelay/issues/93)) ([509884e](https://github.com/krasnoperov/patchrelay/commit/509884e648f4d597abf854c59d9175c91a15db72))

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
