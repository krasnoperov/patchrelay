# PatchRelay Refactoring Plan

This document is the active forward plan for aligning `patchrelay` with `../patchrelay-v2`.

It is intentionally short. Completed historical work has been trimmed so this file stays useful as an execution guide rather than a project diary.

## Current Follow-up Slice: GitHub-Only Review Loop

This is the current cleanup priority for the requested-changes path.

### Goals

- make requested-changes progress impossible to fake
- keep PatchRelay/review automation communication strictly on GitHub
- make the loop explainable from PR head SHA, CI state, and review state alone

### Mental Model

- PatchRelay is a code-changing worker
- review-quill is a GitHub reviewer
- GitHub is the only shared protocol between them
- after requested changes, PatchRelay either pushes a new head or escalates
- the same head SHA must never be treated as "back in review"

### Current File Targets

- [src/run-orchestrator.ts](/home/alv/projects/patchrelay-handoff/src/run-orchestrator.ts)
  - keep the "new head or escalate" invariant obvious in prompts, post-run checks, and reconciliation
  - keep branch-upkeep flow distinct from ordinary requested-changes work
- [src/idle-reconciliation.ts](/home/alv/projects/patchrelay-handoff/src/idle-reconciliation.ts)
  - recover from fresh GitHub truth using head advancement, not reviewer-request state
- [src/cli/cluster-health.ts](/home/alv/projects/patchrelay-handoff/src/cli/cluster-health.ts)
  - describe same-head stalls and newer-head waiting states in plain git terms
- [packages/review-quill/src/prompt-builder/render.ts](/home/alv/projects/patchrelay-handoff/packages/review-quill/src/prompt-builder/render.ts)
  - keep the current diff authoritative
  - treat previous reviews as short claims to verify, not raw narrative to repeat
- [packages/review-quill/src/service.ts](/home/alv/projects/patchrelay-handoff/packages/review-quill/src/service.ts)
  - keep review publication fully GitHub-native
  - avoid any hidden handoff semantics beyond GitHub reviews on the latest head

## Current Alignment

PatchRelay is already much closer to `patchrelay-v2` than before.

Aligned now:

- PatchRelay owns delegated implementation work and maintenance of PatchRelay-authored PRs through review and queue wait.
- PR ownership is effectively author-based, not handed off to merge-steward.
- `IssueSession` exists as a real durable record with session state, waiting reason, thread generation, lease fields, summary, PR/head info, and wake events.
- Lease fencing is in place for the dangerous control paths.
- Queue-label control flow is gone, and `queue_label_applied` is retired from active runtime use.
- Operator-facing reads are mostly `sessionState + waitingReason` first.
- Routine Linear noise is reduced, and issues now leave backlog earlier as work progresses.
- Direct human replies to outstanding PatchRelay questions resume the same session more cleanly.

Important intentional divergence:

- merge-steward currently merges by pushing the validated speculative branch to `main`
- for now, treat that as the real contract unless we explicitly decide to redesign it

## Remaining Internal-State Debt

The main remaining debt is no longer labels, leases, or dashboard scope. It is the internal runtime model.

### 1. `factoryState` still drives too much runtime logic

This is the biggest remaining architectural gap.

Today, the runtime still branches on values like:

- `implementing`
- `pr_open`
- `changes_requested`
- `repairing_ci`
- `awaiting_queue`
- `repairing_queue`

That logic still lives heavily in:

- [src/run-orchestrator.ts](/home/alv/projects/patchrelay/src/run-orchestrator.ts)
- [src/idle-reconciliation.ts](/home/alv/projects/patchrelay/src/idle-reconciliation.ts)
- [src/github-webhook-handler.ts](/home/alv/projects/patchrelay/src/github-webhook-handler.ts)
- [src/db.ts](/home/alv/projects/patchrelay/src/db.ts)

`IssueSession` is visible and real, but `factoryState` is still a true control plane rather than only a projection.

### 2. `pendingRunType` is still acting like a second scheduler

`pendingRunType` is still useful operationally, but it remains part of the control plane instead of being a narrowly-scoped execution intent.

At the end state, PatchRelay should mostly decide work from:

- session state
- unresolved session wake events
- fresh GitHub truth

not from a long-lived pending run type field.

### 3. Thread rules are better, but not fully closed out

We have initial/follow-up prompt separation and better direct-reply handling, but thread compaction/replacement still needs tighter rules and focused coverage.

### 4. `operator-feed` is still broader than pure audit/history

It no longer drives live watch-list state, which was the important fix. But it is still a fairly large subsystem, and some timeline/history views still expose old state-machine language.

### 5. Tests still encode too much of the old model

Many tests still treat `factoryState` transitions as the thing being verified rather than session/event behavior. That keeps the older model sticky.

## Decision

For scale and reliability, the target model should be:

- `IssueSession` as the only authoritative runtime record
- session-event inbox as the wake source
- fresh GitHub truth at decision points
- `factoryState` reduced to derived compatibility/debug output, then removed

This is the model most likely to remain understandable and reliable at thousands of issues per day.

## Next Refactor Slices

### Slice 1. Make `IssueSession` The Scheduler Source

Goal:

- stop using `factoryState` as the primary branching variable in scheduling

Primary targets:

- [src/run-orchestrator.ts](/home/alv/projects/patchrelay/src/run-orchestrator.ts)
- [src/idle-reconciliation.ts](/home/alv/projects/patchrelay/src/idle-reconciliation.ts)
- [src/github-webhook-handler.ts](/home/alv/projects/patchrelay/src/github-webhook-handler.ts)
- [src/issue-session.ts](/home/alv/projects/patchrelay/src/issue-session.ts)
- [src/db.ts](/home/alv/projects/patchrelay/src/db.ts)

Work:

- introduce one canonical "next action" resolver driven by:
  - `sessionState`
  - `waitingReason`
  - pending session event
  - fresh GitHub truth
- rewrite post-run completion to use that resolver first
- rewrite idle reconciliation to append/consume session events and then use that resolver
- rewrite GitHub follow-up routing to compute next action from session facts instead of directly mapping to `factoryState`
- continue moving Linear webhook wakeups onto the session inbox first
  - comments, prompts, and dependency-unblock wakeups should enqueue from `peekIssueSessionWake(...)`, not from raw `pendingRunType`
- continue moving GitHub/reactive wakeups onto the session inbox first
  - review changes, CI repair, queue repair, and idle dependency-unblock wakeups should enqueue from `peekIssueSessionWake(...)`, not directly from compatibility stage writes

Definition of done:

- orchestrator and reconciliation no longer fundamentally schedule from `factoryState`

### Slice 2. Reduce `factoryState` To Compatibility Only

Goal:

- keep old reads/tests working temporarily
- stop using `factoryState` as authoritative runtime state

Work:

- centralize `factoryState` derivation from:
  - `sessionState`
  - `waitingReason`
  - PR truth
  - latest reactive intent
- remove hand-authored `factoryState` transitions from webhook/service paths
- keep one compatibility projection helper for debug UI and old tests

Definition of done:

- runtime writes session facts, not stage labels

### Slice 3. Demote `pendingRunType`

Goal:

- stop using `pendingRunType` as a hidden scheduler

Work:

- derive next run type from session event + fresh GitHub truth where possible
- keep only minimal queued execution intent when a wake has already been admitted but not started
- remove broad use of `pending_run_type` from read surfaces

Definition of done:

- readiness comes from unresolved session wake + no active run + no blockers

### Slice 4. Finish Thread Rules

Goal:

- make thread reuse / fresh-turn / interruption policy explicit and testable

Work:

- codify when PatchRelay should:
  - steer the current thread
  - append follow-up to the same thread
  - compact/replace the thread
  - force a fresh thread because the premise changed
- add focused tests for restart, stale thread, and explicit-question reply cases

Definition of done:

- thread policy is documented in code and covered by focused tests

### Slice 5. Delete Legacy Runtime Surfaces

Goal:

- remove the old state machine once the session/event model really carries runtime behavior

Work:

- delete obsolete `factoryState` transition helpers
- delete remaining queue/review-label-era helpers
- shrink operator-feed usage to audit/history only
- prune tests that only assert old stage-machine internals

Definition of done:

- the live runtime can be understood from `IssueSession`, session events, and fresh GitHub truth

## TST Validation Plan

Refactoring and live operation should stay coupled.

For each slice:

1. land the code change
2. choose or create a targeted `TST` issue
3. delegate it to PatchRelay
4. observe Linear, PatchRelay, GitHub, and merge-steward
5. manually review/approve or request changes
6. watch queue and deploy behavior
7. fix any drift before proceeding

### Required TST Lanes

Keep using live `TST` issues to exercise all of these:

1. Clean happy path
Purpose: delegate -> implement -> PR -> review -> queue -> merge with no repair loops.

2. Review fix
Purpose: requested changes wake the same session correctly and preserve repair intent.

3. CI repair
Purpose: a red required check produces `ci_repair` and PatchRelay closes the loop.

4. Queue repair
Purpose: merge-steward eviction/spec conflict produces `queue_repair` and a fresh queue attempt.

5. Parallel pressure
Purpose: multiple delegated issues run in parallel without duplicate starts or misleading state.

6. Restart recovery
Purpose: service restarts do not lose lease ownership or repair intent.

### Standing TST Pool

Maintain a standing pool of issues so we always have live pressure available:

- 2 clean docs/content issues
- 2 UI/route issues
- 2 workflow/CI issues
- 2 intentionally overlapping/conflicting issues
- 1 planning-only no-PR issue
- 1 dependency-chain issue

If the pool runs dry, create more TST issues in:

- `/game` facilitator improvements
- SEO / content / docs work
- CI/workflow speedups
- small UI route refinements
- overlapping file-touching changes to exercise queue repair

## Exit Criteria

This cleanup is done only when all of these are true:

- `IssueSession` is the only authoritative runtime model
- scheduling is driven by session events plus fresh GitHub truth
- `factoryState` is either derived debug output or deleted
- `pendingRunType` is no longer a hidden second scheduler
- dashboard and Linear progress views match real execution closely
- fresh `TST` issues have successfully exercised:
  - happy path
  - review fix
  - CI repair
  - queue repair
  - parallel execution
  - restart recovery

At that point the system is not just “refactored.” It is operationally proven.
