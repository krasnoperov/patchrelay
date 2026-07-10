# Issue-session projector coupling

Status: **observation only** — current facts, no proposed fix.

## Summary

The persistence layer cannot store an issue or a run without also recomputing
an operator-facing read model. Every write to `IssueStore`/`RunStore` fires a
projector that derives view fields and rewrites the denormalized
`issue_sessions` row. This fuses persistence (store data) with read-model
shaping (derive a view), which the architecture guardrails call out as a
god-file/layering smell. It is recorded here because, unlike most such smells,
it resists a simple extraction — the constraints below are the reason.

## What exists

`PatchRelayDatabase` injects an anonymous `projectIssueSessionReadModel`
closure into both stores at construction (`src/db.ts`). The closure runs on
six write paths:

| Store | Method | Site |
|-|-|-|
| `IssueStore` | `upsertIssue` | `src/db/issue-store.ts:119` |
| `RunStore` | `createRun` | `src/db/run-store.ts:47` |
| `RunStore` | `finishRun` | `src/db/run-store.ts:105` |
| `RunStore` | `markSuperseded` | `src/db/run-store.ts:146` |
| `RunStore` | `updateRunThread` | `src/db/run-store.ts:174` |
| `RunStore` | `markCompletionCheckStarted` | `src/db/run-store.ts:228` |

The projector (`src/issue-session-projector.ts`) is not a thin write. On each
invocation it:

- reads from three stores — `issueSessions.getIssueSession`,
  `runs.getLatestRunForIssue`, `issues.listIssueDependencies`,
  `workflowTasks.listOpenRunnableTasks`, `issueSessions.listIssueSessionEvents`;
- calls the read-model builder `buildTrackedIssueRecord`
  (`src/tracked-issue-projector.ts`);
- derives `sessionState`, `waitingReason`, `summaryText`, `lastWorkflowReason`,
  `threadGeneration`;
- writes the `issue_sessions` row (INSERT or UPDATE).

So a single `upsertIssue` triggers several reads, a read-model computation, and
a second write — all inside what is nominally a persistence call.

## The `issue_sessions` table has three roles at once

`issue_sessions` (schema `src/db/migrations.ts:86-101`) is not purely a read
model. The same row carries:

- **Denormalized read-model fields**: `waiting_reason`, `summary_text`,
  `session_state` — operator-facing, derived from issue/run state.
- **Path-dependent state**: `thread_generation` increments off its own previous
  value (`issue-session-projector.ts:37-39`: `existing.threadGeneration + 1`
  when the active thread changes); `display_updated_at` is a sortable
  projection timestamp. Neither is a pure function of current issue/run state.
- **Session / lease state**: `active_run_id`, `lease_id`, `leased_until`
  (indexed by `idx_issue_sessions_lease`), driving the issue-session lease
  machinery (`upsertIssueWithLease`, `getActiveIssueSessionLease`, …).

The row is read directly and frequently — the tracked-issue list
(`IssueSessionStore.listTrackedIssueRows`), the CLI, the watch TUI, and
cluster-health all consume it as a materialized snapshot.

## Why it is concerning

- **Layering**: it violates the project's own rule — "Persistence modules store
  and load data. They should not shape UI or operator-facing read models"
  (`docs/architecture-guardrails.md`). The store layer owns view derivation.
- **Hidden cost on the hot path**: every issue/run mutation pays for several
  reads plus a read-model computation, whether or not any reader needs the
  refreshed view at that moment.
- **Tangled dependency cycle**: `db.ts` constructs `IssueStore` with a closure
  that reaches back into `issueSessions`, `runs`, and a read-model builder —
  the stores are wired to each other through the projector rather than being
  independent.
- **Opaque seam**: the projection trigger is an anonymous inline closure, not a
  named, typed contract, so the "every write reprojects" invariant is implicit.

## Why it does not yield to a simple extraction

These are facts about the current shape, not a proposed solution:

- The read model is **materialized, not computed on read** — moving derivation
  to the query layer would require recomputing a multi-join and the derivations
  on every read (the table is read on hot paths).
- The materialized row includes **path-dependent state** (`thread_generation`,
  `display_updated_at`) that cannot be reconstructed from a current snapshot of
  `issues`/`runs`.
- The same table is the **lease/session state of record**, so it cannot be
  treated as a disposable view.
- The eager-on-write invariant is currently what guarantees readers see a
  consistent snapshot; the coupling is the price of that guarantee.

## References

- `src/db.ts:51-67` — projector wiring
- `src/issue-session-projector.ts` — the projector
- `src/db/issue-store.ts:119`, `src/db/run-store.ts:47,105,146,174,228` — fire sites
- `src/db/migrations.ts:86-101` — `issue_sessions` schema
- `docs/architecture-guardrails.md` — the rule it crosses
