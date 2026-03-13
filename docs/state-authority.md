# State Authority In PatchRelay

## Purpose

PatchRelay is a harness. Its persistence model should protect the facts that the harness must own
to coordinate work safely, while avoiding turning the database into a second copy of every external
system.

This note distinguishes authoritative state from derived state so future features can decide what
must be persisted, what can be reconstructed, and what should remain an optional cache or artifact.

For the current table-by-table classification, see [persistence-audit.md](./persistence-audit.md).

## Authoritative State

Authoritative state is information PatchRelay must own directly because losing it would make
coordination unsafe, ambiguous, or hard to recover after a restart.

In PatchRelay, authoritative state includes:

- webhook deduplication and processing status
- active issue-to-workspace ownership
- active issue-to-stage ownership
- active issue-to-thread correlation
- persisted issue-to-session handoff history used to reopen the right Codex session in the issue worktree
- queued user or Linear input that has not yet been delivered to a live turn
- Linear installation links, OAuth state, and encrypted installation tokens
- service-owned workflow sync metadata such as the status comment PatchRelay is expected to refresh

This is the minimum harness ledger. It tells PatchRelay what work it owns, where that work is
running, which external side effects it is responsible for, and what must happen next.

## Derived State

Derived state is information that can be recomputed from authoritative state plus external systems
or durable artifacts already owned elsewhere.

In PatchRelay, derived state often includes:

- rendered inspection views
- summaries that can be rebuilt from stage reports and thread history
- verbose event trails used mainly for debugging
- cached issue metadata that Linear still owns as the upstream source of truth
- cached thread details that `codex app-server` can still return
- historical views assembled from completed stage runs, archived webhook payloads, and worktree
  metadata

Derived state can still be worth storing for speed or operator ergonomics, but it should be treated
as a cache or artifact rather than a coordination dependency.

## Decision Rule

When adding a new persisted field, table, or file, ask these questions in order:

1. If this disappeared during a restart, could PatchRelay still safely determine ownership and next
   action?
2. Is PatchRelay the only trustworthy source for this fact?
3. Would recomputing it require replaying external side effects or making unsafe assumptions?
4. Is it needed for correctness, or only for debugging, visibility, or convenience?

If the answer to the first three questions is yes, it is probably authoritative state.
If the answer to the fourth question is yes, it is probably derived state and should not become a
hard dependency of the orchestration loop.

## Persistence Guidance

Use SQLite for authoritative coordination state:

- webhook receipt and dedupe records
- active issue control state
- active stage ownership
- active thread correlation
- undelivered obligations
- installation, OAuth, and token linkage

Prefer reports, archives, or optional caches for derived state:

- archived webhook payload files
- stage reports
- operator-facing inspection material
- raw event logs when they are not required for restart correctness

This keeps SQLite as the harness ledger rather than an ever-growing mirror of Linear, Codex, and
the local filesystem.

## Current Store Audit

The current persistence model is closest to the following split:

### Authoritative SQLite State

- `webhook_events`
  Needed for dedupe, processing status, and safe webhook intake.
- `event_receipts`
  Needed for accepted webhook identity, dedupe correlation, and desired-stage trigger ownership.
- `issue_control`
  Needed for desired stage, active run lease, active workspace ownership, lifecycle status, and
  service-owned Linear anchors.
- `workspace_ownership`
  Needed for durable issue-to-worktree ownership.
- `issue_sessions`
  Needed for restart-safe issue-to-session handoff and deterministic `patchrelay open` behavior.
- `run_leases`
  Needed for issue-to-thread correlation and restart-safe execution ownership.
- `obligations`
  Needed so human or Linear follow-up input is not lost before delivery to a live turn.
- `linear_installations`, `project_installations`, `oauth_states`
  Needed for installation linkage, token ownership, and safe OAuth completion.

### Derived Or Artifact-Like State

- `issue_projection`
  Useful for CLI and HTTP lookups, but not required to decide ownership or next action.
- `run_reports`
  Useful for operator reporting, but rebuildable from thread history and completion state.
- `run_thread_events`
  Useful for operator history, event counts, and debugging, but not required to continue or safely
  stop a run.
- archived webhook payload files
  Useful for debugging and audit trails, but not required for restart correctness.
- rendered stage reports and CLI views
  Useful for inspection, but rebuildable from authoritative state plus upstream systems.

### Fields Worth Watching

These are reasonable today, but should be reviewed before adding more persistence around them:

- cached issue title, key, and URL in `issue_projection`
- cached current Linear state in `issue_projection`
- detailed event payloads in `run_thread_events`

They are helpful for operator ergonomics, but they should stay secondary to the core coordination
ledger.

## Design Implications

- Restart and reconciliation should depend only on authoritative state plus upstream systems.
- Inspection should tolerate missing caches and rebuild from durable sources when needed.
- New features should start by identifying the single fact PatchRelay truly needs to own.
- A feature is not justified in SQLite just because it is useful to query.

The goal is not to minimize persistence for its own sake. The goal is to keep PatchRelay's stored
state small, durable, and clearly tied to harness correctness.
