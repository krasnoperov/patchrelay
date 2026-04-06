# PatchRelay V2 Refactoring Plan

This document captures the gap between the current `patchrelay` implementation and the desired `patchrelay-v2` architecture in `../patchrelay-v2`.

The goal is to refactor this repo toward the `v2` model where:

- `patchrelay` owns delegated implementation work and maintenance of PatchRelay-owned PRs
- `reviewbot` owns review automation
- `merge-steward` owns queue admission and merge execution
- GitHub is the source of truth for PR lifecycle and readiness
- PatchRelay runtime is centered on a small durable `IssueSession`

## Target Contract

The `v2` repo defines these core rules:

- PR ownership is determined by PR author, not by issue delegation state
- PatchRelay handles only PRs that PatchRelay created
- PatchRelay opens draft PRs during implementation and marks them ready when implementation is done
- ready-for-review, green CI, and approval do not by themselves start new PatchRelay work
- Review and merge are downstream responsibilities owned by `reviewbot` and `merge-steward`
- PatchRelay runtime state should be modeled as `idle | running | waiting_input | done | failed`
- review and queue waiting should be represented as `waitingReason`, not as major runtime states

Key source docs:

- `../patchrelay-v2/docs/architecture.md`
- `../patchrelay-v2/docs/codex-session-runtime.md`

## Main Gaps In The Current Repo

### 1. Ownership handoff is still built into the runtime

The current code treats PR responsibility as transferable after review/queue handoff:

- `src/db-types.ts` defines `BranchOwner = "patchrelay" | "merge_steward"`
- `src/github-webhook-handler.ts` sets branch ownership to `merge_steward` on `awaiting_queue`
- current docs describe Merge Steward as taking over after approval

This conflicts with the `v2` rule that PR ownership stays with the PR creator until merge or close.

Implication:

- PatchRelay must remain responsible for its own PRs even after they become ready, enter review, or enter the queue

### 2. PatchRelay still owns downstream review and queue admission mechanics

The current service actively requests downstream steps:

- `src/review-label-protocol.ts` adds and clears review labels
- `src/merge-queue-protocol.ts` adds the queue admission label
- `src/github-webhook-handler.ts` triggers those handoffs when issue state changes

This is broader than the `v2` boundary. In `v2`, PatchRelay should make its own PR ready and then stop treating review/merge as internal stages it controls.

Implication:

- review labels and queue labels should not be PatchRelay's internal gating mechanism
- downstream services should detect readiness from GitHub truth

### 3. The persistent state model is larger than the desired `IssueSession`

The current repo persists a broader factory-state machine and several queue/review-specific fields:

- `src/factory-state.ts` includes `pr_open`, `awaiting_queue`, `repairing_queue`, and `changes_requested`
- `src/db-types.ts` persists queue/review provenance and branch ownership
- `src/db/migrations.ts` includes many fields for internal queue and repair flow tracking

In `v2`, the durable model should be much smaller:

- session state
- repository and branch
- current PR number and head SHA
- waiting reason
- short summary
- retry/escalation data
- lease/runtime coordination data

Implication:

- PatchRelay should persist only its own runtime state
- GitHub review/check/queue truth should be fetched or derived fresh, not promoted into a larger internal lifecycle model

### 4. Observability scope is broader than PatchRelay's actual responsibility

The current repo exposes a rich operator surface:

- `src/http.ts` exposes timeline, live run, raw run events, feed SSE, and watch SSE
- `src/issue-query-service.ts` reconstructs timelines, queue protocol details, feed events, and live thread snapshots
- `src/operator-feed.ts` supports a general-purpose operator event stream
- `src/cli/help.ts` advertised `feed`, `dashboard`, `issue report`, and `issue events`

That exceeds the `v2` service boundary. It makes PatchRelay feel like the dashboard for the whole delivery system instead of the execution harness for PatchRelay-owned work.

Implication:

- dashboard/API scope should be reduced to PatchRelay-owned runtime only
- queue visualization should live with `merge-steward`
- review visualization should live with `reviewbot` or GitHub itself

## Recommended Refactor Direction

## 1. Lock The Contract First

Before changing code, promote the `v2` model into authoritative docs and tests in this repo.

Add contract coverage for:

- PR ownership never transfers away from the PR creator
- PatchRelay ignores PRs it does not own
- green CI does not start PatchRelay work
- approval does not start PatchRelay work
- ready-for-review does not start PatchRelay work
- PatchRelay wakes only for delegated issue start, trusted follow-up, requested changes, red CI, merge-steward incident, merge, close, or reconciliation

This should happen first so the implementation refactor stays anchored to stable rules.

## 2. Remove Ownership Handoff

Refactor away the explicit branch ownership transfer model.

Changes:

- remove `merge_steward` as a branch owner state
- stop reassigning ownership on `awaiting_queue`
- make PatchRelay ownership derive from a concrete GitHub fact: PR author identity
- ensure PatchRelay continues to repair only PatchRelay-authored PRs even if the issue is later undelegated

Result:

- ownership becomes simple, stable, and aligned with `v2`

## 3. Stop Using PatchRelay As The Review And Queue Gatekeeper

PatchRelay should stop orchestrating downstream review/queue handoff through labels as a core contract.

Changes:

- deprecate `src/review-label-protocol.ts`
- deprecate `src/merge-queue-protocol.ts` as PatchRelay-owned gating
- remove automatic review-label and queue-label application from the GitHub webhook flow
- make PatchRelay responsible only for:
  - opening draft PRs
  - updating PatchRelay-owned PRs
  - marking its own PR ready when implementation is complete

Result:

- `reviewbot` and `merge-steward` become GitHub-first services as described in `v2`

## 4. Introduce A Real `IssueSession` Model

Add a new persistence model alongside the current schema first, then migrate runtime code to it.

Recommended `IssueSession` fields:

- session id
- project id
- linear issue id
- issue key
- repo identity
- branch name
- worktree path
- PR number
- head SHA
- session state: `idle | running | waiting_input | done | failed`
- waiting reason
- short summary
- active thread id
- thread generation
- lease id
- worker id
- leased until
- retry counters
- created at / updated at

Optional but still PatchRelay-owned:

- last follow-up reason
- last authoritative GitHub refresh time
- active question awaiting user input

Do not use the new model as authority for:

- review approval
- queue admission
- merge readiness
- generic queue state

Those remain GitHub or downstream-service truth.

## 5. Replace The Current Factory-State-Centric Runtime

Move from the current multi-stage issue factory model to the `v2` runtime model.

Current broad states:

- `delegated`
- `implementing`
- `pr_open`
- `changes_requested`
- `repairing_ci`
- `awaiting_queue`
- `repairing_queue`
- `awaiting_input`
- `escalated`
- `done`
- `failed`

Target runtime states:

- `idle`
- `running`
- `waiting_input`
- `done`
- `failed`

Represent waiting situations using `waitingReason`, for example:

- `waiting_for_human_reply`
- `waiting_for_reviewbot`
- `waiting_for_ci`
- `waiting_for_merge_steward`
- `waiting_for_followup_event`

Reactive work should follow the `v2` event rules:

- terminal events close the session
- premise-changing events create a fresh branch-mutating turn
- direct replies prefer steer
- additive clarifications batch or steer depending on whether a turn is active
- inert self-generated events are recorded but do not start a turn

## 6. Shrink Observability To PatchRelay Responsibilities Only

This is one of the most important refactors.

PatchRelay's dashboard should answer only:

- Is PatchRelay currently active on this issue?
- Which repo, branch, and PR belong to this session?
- What is PatchRelay waiting for?
- Why did PatchRelay last wake up?
- What was the last meaningful outcome?

It should not try to be:

- the merge queue dashboard
- the global review dashboard
- the full transcript browser for every run
- the cross-service source of truth for downstream automation

### Recommended removals or de-emphasis

Review these surfaces first:

- `/api/feed`
- `/api/watch`
- `/api/watch/issues`
- `/api/issues/:issueKey/timeline`
- `/api/issues/:issueKey/runs/:runId/events`
- queue protocol details from `IssueQueryService`
- queue observations and queue state visualizations
- CLI `dashboard`
- CLI `feed`
- CLI commands focused on raw event/timeline browsing

### Recommended replacement surface

Keep a minimal session view that includes:

- issue key and title
- repo and branch
- PR link
- session state
- waiting reason
- active run type, if any
- last summary
- retry budget status
- last PatchRelay-owned wake-up reason

This gives operators enough information to act without turning PatchRelay into the observability center for unrelated responsibilities.

## 7. Migrate In Two Phases

Do not attempt a big-bang rewrite.

### Phase A: Add the new model and dual-write

- add `IssueSession` tables and types
- dual-write from existing webhook/orchestrator flows
- add contract tests for `v2` behavior
- keep old APIs temporarily for compatibility

This phase is about creating the new source of truth without breaking the current system immediately.

### Phase B: Switch reads, then delete old concepts

- move runtime scheduling to `IssueSession`
- update webhook handling to use the `v2` start rules
- switch UI/API reads to the new session model
- remove branch ownership handoff
- remove label-driven review/queue orchestration
- remove old dashboard/feed/timeline/event surfaces
- delete obsolete state fields and migrations only after the new paths are stable

This phase is where the codebase actually becomes `v2`.

## Concrete Work Breakdown

### Track 1: Contract And Docs

- copy the `v2` architecture and runtime rules into this repo's authoritative docs
- update README and architecture docs to stop saying Merge Steward "takes over" the PR
- redefine PatchRelay observability scope in docs

### Track 2: Ownership And Eventing

- remove branch ownership transfer
- derive PatchRelay PR ownership from GitHub author identity
- update webhook processing to ignore non-PatchRelay-owned follow-up events
- align event start rules with `v2`

### Track 3: Persistence

- add `IssueSession` schema
- add lease fields
- add waiting reason and summary fields
- migrate from factory-state-centric persistence to session-centric persistence

### Track 4: Runtime

- collapse state handling to `idle | running | waiting_input | done | failed`
- refactor prompt construction around initial vs follow-up turns
- adopt fresh-turn behavior for premise-changing events
- preserve the same thread across follow-up work unless compaction/replacement is required

### Track 5: Downstream Service Boundaries

- remove review-label protocol from PatchRelay core flow
- remove queue-label protocol from PatchRelay core flow
- keep only PatchRelay-owned repair triggers from GitHub truth

### Track 6: Observability Cleanup

- replace dashboard/feed/timeline/event APIs with a minimal session-status surface
- keep only PatchRelay-owned runtime summaries
- move queue-specific visibility expectations to `merge-steward`

## Recommended First Implementation Slice

The safest first slice is:

1. Add contract tests that encode the `v2` rules
2. Remove branch ownership transfer
3. Introduce `IssueSession.waitingReason` and a minimal session projection
4. Stop emitting queue/review handoff behavior from PatchRelay
5. Replace the current dashboard payload with a PatchRelay-only session summary

That sequence reduces architectural drift quickly without requiring a full runtime rewrite on day one.

## Desired End State

When this refactor is done:

- PatchRelay is smaller and easier to reason about
- GitHub is the authoritative PR truth
- PatchRelay runtime state reflects only PatchRelay's own work
- review and queue responsibilities are clearly externalized
- dashboard/API output reflects only PatchRelay's own responsibilities
- the codebase matches the architecture described in `../patchrelay-v2`

## Implementation Checklist

Use this as the execution order for the refactor. The early phases are designed to reduce architectural drift without requiring a full rewrite immediately.

### Phase 0: Contract Lock

- [x] Update `README.md` to describe PatchRelay as owner of delegated work plus PatchRelay-owned PR upkeep, not the review/queue control plane.
- [x] Update `ARCHITECTURE.md` and `docs/architecture.md` to mirror the `v2` ownership and runtime model.
- [x] Add a short doc section defining PR ownership by PR author identity.
- [x] Add a short doc section defining `IssueSession` as PatchRelay's durable runtime record.
- [x] Add tests that assert green CI does not start PatchRelay work.
- [x] Add tests that assert approval does not start PatchRelay work.
- [x] Add tests that assert ready-for-review does not start PatchRelay work.
- [x] Add tests that assert PatchRelay ignores follow-up on non-PatchRelay-owned PRs.
- [x] Add tests that assert PatchRelay does react to requested changes, settled red CI, trusted follow-up comments, merge-steward incidents, merge, and close on PatchRelay-owned PRs.

### Phase 1: Ownership Simplification

- [ ] Remove the conceptual branch ownership handoff from docs and comments.
- [x] Remove `merge_steward` from `BranchOwner` in `src/db-types.ts`.
- [x] Stop setting branch ownership to `merge_steward` in `src/github-webhook-handler.ts`.
- [x] Remove or simplify `setBranchOwner` usage in `src/db.ts`.
- [x] Replace ownership checks with a GitHub-author-based PatchRelay PR ownership predicate.
- [x] Store the minimum PR ownership fact needed for reconciliation if it cannot be derived cheaply on demand.
- [x] Add regression tests for "ownership does not change after ready/review/queue transitions".

### Phase 2: Remove PatchRelay-Owned Review And Queue Gating

- [ ] Mark `src/review-label-protocol.ts` as deprecated in docs or remove it once no longer used.
- [ ] Mark `src/merge-queue-protocol.ts` as deprecated in docs or remove it once no longer used.
- [ ] Remove automatic review-label requests from `src/github-webhook-handler.ts`.
- [ ] Remove automatic review-label clearing from `src/github-webhook-handler.ts` and `src/run-orchestrator.ts`.
- [x] Remove automatic queue-label admission requests from `src/github-webhook-handler.ts`.
- [x] Remove queue-label admission requests from reconciliation paths in `src/run-orchestrator.ts` and related helpers.
- [x] Update tests so PatchRelay marks PRs ready but does not gate review/merge itself.
- [x] Verify any remaining queue-repair behavior is triggered only by `merge-steward` incident/failure signals, not by PatchRelay-owned queue state.

### Phase 3: Add `IssueSession` Persistence

- [x] Add a new `issue_sessions` table in `src/db/migrations.ts`.
- [x] Define `IssueSession` types in a dedicated runtime-facing module.
- [x] Include fields for session state, waiting reason, summary, repo identity, branch, worktree, PR number, head SHA, thread generation, and retry counters.
- [x] Include lease fields: `leaseId`, `workerId`, `leasedUntil`.
- [x] Add an append-only session event or inbox table if needed for `v2` scheduling rules.
- [x] Add DB access methods in `src/db.ts` for creating, reading, leasing, and updating sessions.
- [x] Keep legacy issue records intact during transition.
- [x] Add migration tests covering creation and upgrade of existing databases.

### Phase 4: Dual-Write Runtime State

- [x] Update `src/webhook-handler.ts` to create or update an `IssueSession` when delegation begins.
- [x] Update `src/github-webhook-handler.ts` to append PatchRelay-relevant follow-up events into the new session model.
- [x] Update `src/run-orchestrator.ts` to dual-write run lifecycle updates into both legacy issue state and the new session state.
- [x] Populate `waitingReason` instead of inventing new durable lifecycle states for review/queue waiting.
- [x] Write `headSha` into the session whenever authoritative GitHub truth changes.
- [x] Persist last summary and last wake-up reason into the session record.
- [x] Add tests that verify old and new models stay in sync during the transition.

### Phase 5: Replace Factory-State-Centric Scheduling

- [x] Add the new runtime state enum: `idle | running | waiting_input | done | failed`.
- [x] Introduce a `waitingReason` enum or stable string constants.
- [x] Refactor run-start decisions to be driven by session events plus current GitHub truth.
- [x] Implement the `v2` terminal event rule: merge, close, undelegation-before-PR, and operator terminal stop close the session.
- [x] Implement the `v2` premise-changing event rule: requested changes, settled red CI, and merge-steward incidents start a fresh branch-mutating turn.
- [ ] Implement the `v2` steer rule for direct replies to explicit agent questions.
- [x] Implement additive clarification batching.
- [ ] Ensure inert self-generated events are recorded but do not start work.
- [ ] Keep old `factoryState` writes only as transitional compatibility until read paths move over.

### Phase 6: Lease And Concurrency Model

- [x] Add renewable lease acquisition and heartbeat logic around session execution.
- [ ] Require lease checks before session writes, PR writes, pushes, or turn starts.
- [x] Handle stale-worker wakeups as read-only.
- [x] Add lease-expiry recovery in reconciliation.
- [x] Add tests for duplicate workers, expired leases, and reclaimed sessions.

### Phase 7: Prompt And Thread Model Alignment

- [ ] Separate prompt builders into explicit initial-prompt and follow-up-prompt paths.
- [ ] Ensure follow-up prompts explain why the turn exists, what changed, and which GitHub facts are authoritative.
- [ ] Make stale or partial GitHub facts explicit in follow-up prompts.
- [x] Reuse the same main thread for follow-up work within a session by default.
- [ ] Add thread compaction/replacement rules that match the `v2` runtime document.
- [x] Ensure merge/close events interrupt active work without starting a new implementation turn.

### Phase 8: Read Path Migration

- [x] Add a minimal session-summary query layer backed by `IssueSession`.
- [x] Update `src/service.ts` to expose session-oriented read methods.
- [x] Update issue overview APIs to read from the new session model first.
- [x] Stop returning queue protocol detail as a core part of issue/session status.
- [x] Stop returning raw thread-event and operator-feed data as default issue status.
- [ ] Keep a temporary compatibility path for old CLI commands if needed while the UI/API migrates.

### Phase 9: Observability Reduction

- [x] Define the minimal dashboard/session payload shape.
- [x] Remove or deprecate `/api/feed`.
- [x] Remove or deprecate `/api/watch`.
- [x] Remove or deprecate `/api/watch/issues`.
- [x] Remove or deprecate `/api/issues/:issueKey/timeline`.
- [x] Remove or deprecate `/api/issues/:issueKey/runs/:runId/events`.
- [x] Remove queue observation building from `src/issue-query-service.ts` and watch views.
- [ ] Remove or de-emphasize `src/operator-feed.ts` if it is no longer needed after the minimal session view lands.
- [ ] Replace the current dashboard/TUI with a PatchRelay-only session view or remove it entirely.
- [x] Update CLI help in `src/cli/help.ts` to match the reduced operator surface.

### Phase 10: Legacy Surface Cleanup

- [ ] Remove old factory-state-specific code paths once all reads and writes use `IssueSession`.
- [ ] Remove unused queue/review label helpers and tests.
- [ ] Remove legacy queue-ownership or queue-visualization helpers.
- [ ] Remove compatibility columns from docs and stop documenting them as important runtime state.
- [x] Delete dead CLI commands related to feed/dashboard/raw events if they are no longer part of the intended product.
- [ ] Prune obsolete tests that encoded the pre-`v2` model.

### Phase 11: Final Verification

- [ ] Run the full test suite.
- [ ] Add focused restart/reconciliation tests for the new session model.
- [ ] Add tests for undelegation after a PatchRelay-owned PR already exists.
- [ ] Add tests for duplicate or out-of-order webhook delivery under the new event model.
- [ ] Add tests that verify PatchRelay remains idle while waiting on reviewbot or merge-steward.
- [ ] Confirm docs, help text, and runtime behavior all tell the same story.

## Live Operational Notes

- PatchRelay now runs with session-event wakeups, renewable issue-session leases, terminal-event shutdown, and startup agent-session resync.
- PatchRelay operator and public status reads now load from `IssueSession` first, with legacy `factoryState` retained only as a compatibility shadow while remaining read paths migrate.
- A live trial on `TST-5` exposed a real publication gap: Codex completed an implementation turn with local worktree changes but without committing or opening a PR. The runtime now verifies publication outcome before treating an implementation turn as successful.
- A live follow-up prompt on `TST-5` successfully queued a continuation turn from existing session state after a service restart.
- A second live delegation on `TST-6` successfully created a new active implementation session while `TST-5` was still in flight.
- `merge-steward` and the PatchRelay GitHub App are now installed on `krasnoperov/ballony-i-nasosy`, branch protection requires one approval plus the `verify` check, and a live trial on `TST-6` successfully progressed through PR creation, approval, queue admission, validation, and merge to `main`.

## Operational Hardening Plan

The remaining work is no longer just "finish the refactor." It is to make the refactor operationally trustworthy under real queue pressure and service restarts.

### PatchRelay

1. Make `IssueSession` the operator truth everywhere.

- Finish migrating CLI, HTTP, watch views, and Linear status reporting to `sessionState`, `waitingReason`, and session wake summaries.
- Keep `factoryState` only as a temporary compatibility shadow for runtime internals and old tests.
- Stop showing queue-label-derived wording like "waiting for merge queue" as if PatchRelay controlled queue admission.
- Fix Linear reporting so delegated active work is not shown as passive `Backlog` or `Needs input` while a session is actually `running`.

2. Remove remaining non-`v2` control facts from PatchRelay.

- Stop treating `queueLabelApplied` as a control-plane fact; keep it only as a short-lived migration aid if it is still needed for compatibility.
- Remove `src/merge-queue-protocol.ts` once no runtime path depends on label-driven admission requests.
- Clean up checklist/docs references to `src/review-label-protocol.ts`; that file no longer exists and should no longer appear in the plan.

3. Finish the event-routing model.

- Implement the direct-reply steer rule for explicit agent questions so human answers do not always become fresh turns.
- Record inert self-generated events without waking work.
- Make terminal events always interrupt and close cleanly.
- Tighten event coalescing so repeated comment-update noise does not look like meaningful wake pressure.

4. Finish the prompt/thread split.

- Separate initial implementation prompts from follow-up repair/prompts.
- Make follow-up prompts explicitly state why the turn exists, what changed, which GitHub facts are authoritative, and which facts may be stale.
- Keep the default single-thread-per-session rule, but add a clean compaction or replacement path when the thread becomes noisy or stale.

5. Enforce leases on every side effect.

- Gate session writes, PR writes, pushes, and finalization on the current session lease.
- Treat stale workers as read-only observers.
- Add restart tests where an old worker wakes up after a new worker already reclaimed the session.

6. Fix packaging and service lifecycle.

- Stop relying on `/usr/bin/env patchrelay` in the systemd unit.
- Make install/restart paths use the built CLI entry directly, the same way `merge-steward` already does.
- Add a doctor or startup check that verifies the installed executable path is real before restart attempts.

7. Close the PR-upkeep gap for PatchRelay-owned review fixes.

- A `review_fix` turn is not truly complete if the requested code change is present but the PR is still `DIRTY` against current `main`.
- After any PatchRelay-owned PR turn that claims success, refresh GitHub PR truth and decide whether another upkeep step is required before stopping.
- For the current live gap, implement this first for `review_fix`: if the PR is still `DIRTY`, queue another upkeep turn that rebases or updates the existing PR branch onto latest `main`, verifies, and pushes again.
- Do not let the ordinary `review_fix` attempt budget block that upkeep lane; once the task is “make the PR clean again,” it should proceed as PR upkeep rather than escalate just because prior review-fix attempts already exist.
- Preserve that upkeep intent across restart and manual retry so `review_fix` does not silently downgrade to plain `implementation`.
- Keep the status surface honest: when the branch still needs upkeep, do not report the issue as simply “waiting for review feedback.”

### Merge Steward

1. Keep queue state GitHub-first, but make the operator view repair-aware.

- Continue showing active queue work from GitHub truth.
- Also surface open repair obligations for evicted PRs in the active view until PatchRelay repairs or the PR closes.
- Keep wording precise: waiting on main verification is not a PR failure; integration conflict is.

2. Strengthen queue-to-repair handoff.

- Preserve enough metadata on queue incidents to help PatchRelay classify them without falling back to heuristic label checks.
- Prefer exact incident facts like `failureClass`, `baseSha`, and current `headSha`.
- Add or expose issue-key or PatchRelay ownership metadata where practical so queue incidents are easier to correlate.

3. Keep review semantics simple for now.

- For the current live loop, human approval is the review source of truth.
- `merge-steward` should continue gating on exact-head GitHub approval plus required checks.
- `reviewbot` can be introduced later without changing PatchRelay's ownership model.

## Bounded Next Milestones

Use these as the last focused refactor slices before treating the `v2` migration as operationally complete.

### 1. Session-First Reads And UI

Goal:

- make `IssueSession` the primary source for operator-facing reads
- keep legacy state only as compatibility shadow data while old paths are retired

Acceptance criteria:

- CLI, HTTP, and watch views default to `sessionState` plus `waitingReason`
- Linear status reporting reflects active `running` work instead of old lifecycle labels like `Needs input` when a session is actually active
- queue wording is no longer presented as a PatchRelay-owned control plane responsibility

### 2. Remove `queueLabelApplied` From Control Flow

Goal:

- stop treating queue-label state as part of PatchRelay's own runtime contract
- keep queue admission as downstream truth owned by GitHub and `merge-steward`

Acceptance criteria:

- no scheduling, reconciliation, or restart path depends on `queueLabelApplied`
- queue repair, merge conflicts, and fresh-main delays are represented through GitHub truth plus `waitingReason`
- PatchRelay can still repair its own PRs, but it no longer needs to model queue admission as a local invariant

### 3. Prompt And Thread Alignment

Goal:

- split initial prompt construction from follow-up prompt construction
- make thread reuse and replacement behavior explicit instead of accidental

Acceptance criteria:

- follow-up prompts state why the turn exists, what changed, and which GitHub facts are authoritative
- stale or partial facts are clearly marked as such
- planning-only delegated issues can finish successfully after creating the required follow-up Linear issues/documents, even if no PR is opened
- direct-reply steering and compaction/replacement rules match the session runtime doc

### 4. Lease Enforcement And Recovery

Goal:

- make lease ownership the guardrail for every write path
- ensure stale workers remain read-only after a lease loss or reclaim

Acceptance criteria:

- every side-effecting write checks the stored lease before mutating state
- stale workers may continue to read but cannot start turns, push commits, or update PRs
- lease expiry recovery in reconciliation can reclaim a stuck session without duplicating side effects
- interrupted `review_fix`, `ci_repair`, and `queue_repair` turns resume in the same repair lane after restart or retry

### 5. Service Packaging Robustness

Goal:

- make restart and local service invocation predictable enough for long live TST runs

Acceptance criteria:

- systemd startup, `patchrelay` CLI startup, and dashboard startup all work from the same installed build
- service restarts do not leave PatchRelay in a state where local edits exist but publication or recovery cannot resume cleanly
- packaging errors surface clearly instead of failing later as dashboard/runtime shape mismatches

### Live Test Matrix

These are the behaviors we should keep pressure-testing with TST issues until the system feels routine:

- several implementation issues in parallel
- overlapping PRs that conflict after one merge lands
- queue eviction followed by PatchRelay repair and successful re-queue
- red PR CI followed by CI repair
- service restart during active implementation and active queue repair
- direct human reply to an explicit agent question
- merge and close events arriving while a turn is active
- fresh-main verification delay after a prior merge

### What Recent TST Runs Taught Us

- `TST-2` showed that queue eviction must not be reclassified as branch CI during reconciliation.
- `TST-7` and `TST-8` showed that Linear/operator status still drifts from the real session state when we keep reporting through old lifecycle language.
- The interrupted `TST-2` repair turn after service restart showed that lease and interrupted-turn handling is much better now, but packaging and restart ergonomics are still brittle.
- The queue behavior around PRs `#4`, `#5`, and `#6` showed that speculative merge conflicts are expected, but the system must describe them clearly and keep the repair obligation visible.
- `TST-15` showed that PatchRelay can correctly detect “review fix already present” but still stop too early: if the PR remains `DIRTY`, PatchRelay must continue into branch upkeep instead of settling idle.
- `TST-15` also showed that retry and restart recovery must preserve the original repair lane; otherwise a review fix can resume as generic implementation and lose the PR-upkeep intent.

## Suggested First PR Sequence

If we want to break this into sane PRs, this is the order I would recommend:

1. Contract docs + contract tests
2. Ownership handoff removal
3. Review/queue label orchestration removal
4. `IssueSession` schema + dual-write
5. Session-based scheduler
6. Lease model
7. Session-based read APIs
8. Dashboard/API reduction
9. Legacy deletion and cleanup
