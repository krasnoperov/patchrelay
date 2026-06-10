# Core simplification plan

Status: proposed (2026-06-10)

Goal: remove the murky/overlapping logic identified in the June 2026 core review while
strengthening the two properties the service is built around: **surviving reboots** and
**recovering from lost webhooks**. The plan is 14 PR-sized stages in 4 phases. Each stage
is independently shippable and deployable; phases are ordered by dependency, not severity.

Root causes being addressed:

1. Run finalization is not crash-idempotent → five overlapping recovery mechanisms
   (`run-recovery-service`, `interrupted-run-recovery`, `run-reconciler`,
   `service-startup-recovery`, `finalizeDanglingActiveRuns`) with two budget systems and
   duplicate post-run state resolvers.
2. Webhook path and reconciliation path write issue state through different doors
   (`upsertIssueRespectingActiveLease` vs raw `upsertIssue` in
   `idle-reconciliation.ts:301`) and re-derive state with near-duplicate logic →
   last-write-wins races and failure-provenance loss.
3. Webhook events are persisted durably but never replayed (`webhook-event-store.ts` has
   no pending-events query; `pending` rows are excluded from archiving forever) → the
   real recovery doctrine is re-derivation, but the code half-pretends it is replay.

Current call-site inventory (June 2026): `issues.upsertIssue(` at ~70 sites across 27
files; lease-respecting writes in 15 files; `finishRun(` in 11 files;
`pendingRunContextJson` string-checks at 32 sites.

---

## Phase A — One door for writes (foundation)

Everything else assumes writes cannot silently clobber each other. Do this first.

### A1. Single issue-state write API with conflict detection
- Add `version INTEGER NOT NULL DEFAULT 0` to `issues` (migration), bumped on every write.
- New method on `IssueSessionStore`: `commitIssueState(params, { expectedVersion, lease? })`
  — wraps lease respect + optimistic version check + transaction in one call. On version
  mismatch: re-read, re-derive, retry once; log a `state_write_conflict` telemetry event
  (we want to *see* how often the race fires in production).
- Migrate the two hottest writers in this PR: `github-webhook-state-projector.ts` and
  `run-finalizer.ts`.
- Verification: unit test that interleaves two writers and asserts the stale one retries
  rather than clobbering.

### A2. Migrate reconcilers to the write API
- `idle-reconciliation.ts` (`advanceIdleIssue`, 20 call sites), `run-reconciler.ts`,
  `merged-linear-completion-reconciler.ts`, `terminal-wake-reconciler.ts`,
  `service-startup-recovery.ts`, `no-pr-completion-check.ts`.
- `advanceIdleIssue` carries the version it read at tick start; a conflict means a
  webhook landed mid-tick — the correct behavior is *skip* (webhook is newer truth),
  which the retry-after-re-read naturally produces.
- This closes the verified webhook-vs-tick race (review finding 2a).

### A3. Migrate remaining writers + enforce the door
- Sweep the long tail (webhooks/, queue-health-monitor, orchestration-parent-wake,
  linear-* sync files, cli/data.ts — full list from the call-site inventory above).
- Fix the direct `UPDATE issues` bypass in `issue-store.ts:203` (clearing active_run_id
  outside `upsertIssue` skips projection).
- Make raw `db.issues.upsertIssue` package-private (only callable from
  `IssueSessionStore`); add a guardrail test that greps `src/` for direct calls outside
  the store (same pattern as existing schema-guard tests). Update
  `docs/architecture-guardrails.md`.

### A4. Multi-table atomicity + projection hygiene
- `finishRunRespectingActiveLease` / `upsertIssueRespectingActiveLease` no longer exist
  as separate half-transactional helpers; run-terminal + issue-update pairs always go
  through one `db.transaction` (the `commitIssueState` callback form).
- Projection invalidation moves *inside* store write methods — callers can no longer
  forget it.
- Drop the duplicated `active_run_id` and repair-counter columns from `issue_sessions`;
  compute on read via join. If profiling shows the join hurts, keep the column but make
  its projection synchronous (exempt from batching).
- Add a strict-mode assertion (dev/test only): reading `issue_sessions` while
  `batchDepth > 0` throws.
- Add CHECK constraint on `issues.factory_state` + validate enums in row mappers
  (throw on unknown value instead of lying via cast).

Phase A exit criteria: every issue-state write goes through one lease-respecting,
version-checked, transactional, projection-invalidating door; `state_write_conflict`
telemetry visible in operator feed.

---

## Phase B — Idempotent finalization, one recovery policy

### B1. Two-phase finalizer
- Split `run-finalizer.ts` into:
  - **`settleRun(runId)`** — fast, transactional, idempotent: mark run terminal, clear
    `issue.activeRunId`, record `prNumber` if the run published one (this is the
    invariant the late-publication guard exists to patch), release lease. Safe to call
    any number of times; calling on an already-settled run is a no-op.
  - **`completeRunSideEffects(runId)`** — slow, retryable: publication verification,
    completion check, Linear reporting, follow-up wake dispatch. Records a
    `side_effects_done` flag on the run row so retries skip finished work.
- A restart between the phases now means delayed side effects, not a stranded issue.
- Verification: crash-injection test — kill the process between settle and side effects,
  restart, assert the issue is routable within one reconciliation tick.

### B2. Delete the dangling-active-run patch
- `finalizeDanglingActiveRuns` (`run-orchestrator.ts:871-920`, PR #566) and its 2-minute
  timer are replaced by: reconciler sees `run terminal && issue.activeRunId === run.id`
  → calls `settleRun` (idempotent, no special case, no own lease choreography).
- Keep the regression test from #566 (USE-364 scenario) pointed at the new path.

### B3. One post-run state resolver
- Merge `resolveCompletedRunState` (`run-completion-policy.ts:26`) and
  `resolveRecoverablePostRunState` (`interrupted-run-recovery.ts:31`) into a single pure
  `resolvePostRunFactoryState(issue, run)` with table-driven tests enumerating
  (runType × outcome × prState × reviewState). Both finalizer and recovery call it.

### B4. Collapse recovery services into RunFailurePolicy
- Merge `run-recovery-service.ts` + `interrupted-run-recovery.ts` + the zombie backoff
  (`zombie-recovery.ts`) into one `RunFailurePolicy` that owns: is this retryable or
  terminal, which budget applies, retry vs escalate vs re-enqueue.
- One budget table (fold the standalone zombie budget into the per-runType budgets in
  `run-wake-planner.ts:114-125`).
- `run-reconciler.ts` and `service-startup-recovery.ts` stop deciding outcomes — they
  only *detect* stranded states and hand them to the policy.
- Ownership after this stage: **detection** = reconciler + startup recovery;
  **decision** = RunFailurePolicy; **execution** = settleRun + wake dispatcher. No other
  component clears `activeRunId` or touches budgets.

### B5. Close the launch races, retire "detached runs"
- Record the Codex thread ID immediately after `startThread`, before `startTurn`
  (`run-launcher.ts:293-323`) — closes the window where a completion notification finds
  no run by thread ID and is dropped.
- With settleRun idempotent and writes versioned, `resolveEffectiveActiveRun`'s
  "detached run" reattachment (`effective-active-run.ts:16`) should no longer trigger.
  Demote it to a logged assertion for one release; delete it once telemetry shows zero
  hits.

Phase B exit criteria: exactly one component clears `activeRunId`; recovery mechanism
count goes 5 → 2 (reconciler-as-detector + startup recovery), both delegating decisions
to one policy; `DANGLING_ACTIVE_RUN_MIN_AGE_MS`, `DEFAULT_ZOMBIE_RECOVERY_BUDGET`, and
`zombie-recovery.ts` are deleted.

---

## Phase C — One recovery doctrine: re-derivation, done right

### C1. Shared PR-facts → factory-state derivation
- Extract one pure function `deriveFactoryStateFromPrFacts(observed, current)` used by
  *both* `github-webhook-state-projector.ts` and `reconcileFromGitHub`
  (`idle-reconciliation.ts:549-822`). The webhook path feeds it event payload facts; the
  reconciler feeds it polled facts. Same inputs → same state, by construction.
- Provenance rule, enforced in the function: failure provenance
  (`lastGitHubFailureHeadSha`, `lastGitHubFailureSignature`) is only cleared when the
  observed evidence is *newer* than the recorded failure (head SHA advanced or the same
  check succeeded on the same head) — never just because the current poll looks green.
  This fixes the swallowed-repair scenario (lost `check_failed` webhook + main advanced).
- Audit every `clearFailureProvenance: true` site in `idle-reconciliation.ts` against
  the rule.

### C2. Demote webhook_events to dedupe + audit log
- Document the doctrine in `docs/architecture.md`: recovery = re-derivation from
  GitHub/Linear via reconciliation; the event store exists for dedupe and forensics,
  not replay.
- On startup, mark rows stuck at `processing_status = 'pending'` older than N minutes as
  `'abandoned'` (with a count in the operator feed — these are crashes worth seeing) and
  include non-pending terminal states in archiving so they stop accumulating.
- Delete any code that implies replay-readiness but is never exercised.

### C3. Shrink the guards
- Late-publication guard (`github-webhook-late-publication-guard.ts`): with B1
  guaranteeing prNumber is recorded in settleRun, reduce the guard to detection +
  operator alert (no autonomous PR-closing on inferred state). Fix its status-condition
  bug (`completed` runs currently bypass it even when prNumber was never recorded).
- Sequence backstop (`github-webhook-sequence-backstop.ts`): dedupe the operator event
  per PR pair; cache changed-file lists (currently ~6 GitHub API calls per `pr_opened`).
  Keep it — it is a legitimate operator-facing warning, just a noisy/expensive one.

Phase C exit criteria: one derivation function with table-driven tests; a lost-webhook
simulation suite passes (drop each webhook type, run reconciliation, assert state
converges *and* failure provenance survives); webhook_events table stops leaking.

---

## Phase D — State model cleanup (mechanical, can interleave after Phase A)

### D1. Typed run context
- One zod-style parser for `pendingRunContextJson` / run `context` (32 sites). Unknown
  or mistyped fields fail loudly at the boundary instead of silently falling back
  (`context?.reviewFixMode === "branch_upkeep"` string checks).

### D2. Discriminated-union session events
- Replace stringly `eventType` checks (`run-wake-planner.ts:52-76` and friends) with a
  typed union + exhaustive switches.

### D3. Unify the "why is this issue not moving" concepts
- Introduce a derived `IssueExecutionState` discriminated union over
  (`delegatedToPatchRelay`, `factoryState`, `activeRunId`, awaiting-input reason) that
  makes illegal combinations unrepresentable at the type level; `waitingReason` becomes
  a pure function of it (it is mostly derived already — finish the job).
- Computed, not stored — no migration; the underlying columns stay.

### D4. Lease hygiene
- Keep TTL + heartbeat (it is the correct crash-safe design — do NOT move to
  explicit-release-only).
- Make the DB lease record the only truth: drop the in-memory `activeSessionLeases` map
  (lost on restart, forces full-TTL waits and startup ambiguity).
- Shorten post-crash reclaim: `reclaimForeignRecoveryLeaseIfSafe` may reclaim when the
  holder's last heartbeat is older than 2× heartbeat interval, instead of waiting for
  full TTL expiry. Simplify its safe-state special cases against the B-phase invariants.

---

## Ordering, risk, verification

Dependency order: A1 → A2 → A3 → A4 → B1 → B2 → {B3, B4, B5} → C1 → {C2, C3}.
D1/D2 are independent (start anytime); D3 after A4; D4 after B2.

Riskiest stages: **A2** (reconciler behavior under conflict changes from clobber to
skip) and **B4** (recovery decision consolidation). Mitigations: conflict telemetry from
A1 lands *before* A2 so we can watch the race rate; B4 keeps the existing recovery tests
(zombie budget, interrupted-turn, USE-364) green against the new policy before deleting
old services.

Cross-cutting verification, built once in Phase A and reused:
- **Crash-injection harness**: kill between any two writes of a multi-step path
  (settle/side-effects, append/dispatch, finishRun/upsertIssue), restart, assert
  convergence within one reconciliation tick.
- **Lost-webhook suite**: for each webhook type, drop it, tick reconciliation, assert
  the derived state matches the webhook-delivered state (this is the executable form of
  the doctrine).
- **Race suite**: webhook write interleaved with reconciliation tick on the same issue;
  assert newest-truth-wins via version conflict, never silent overwrite.

Rollout: deploy after each stage (`pnpm deploy`), watch the queue health monitor and the
new `state_write_conflict` / `abandoned webhook` operator-feed signals for a day before
the next stage. No stage requires downtime; A1's migration is additive.
