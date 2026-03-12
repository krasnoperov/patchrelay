# Next PR Plan: Reconciliation Authority Hardening

## Goal

Strengthen restart reconciliation so it depends only on authoritative harness state plus live reads
from Linear and Codex, not on derived caches or optional event history.

This PR should be a narrow follow-up to the harness-boundaries work. It should harden behavior, not
restructure the whole codebase.

## Why This Is Next

The current branch clarified:

- PatchRelay's layer model
- authoritative versus derived state
- the intended persistence boundaries

The next useful step is to turn that guidance into a tighter restart contract.

## Scope

Focus on the restart and reconciliation path across:

- `src/service-runtime.ts`
- `src/service-stage-finalizer.ts`
- `src/db/issue-workflow-store.ts`
- `src/stage-turn-input-dispatcher.ts`

## Planned Changes

### 1. Define the authoritative restart contract

Document and enforce the minimum state needed to resume or fail back work safely:

- active stage run id
- issue lifecycle status
- persisted thread id and turn id when present
- service-owned active Linear state expectation
- undelivered queued turn inputs

### 2. Reduce reconciliation dependence on derived state

Audit the reconciliation and completion paths for any reliance on:

- raw `thread_events`
- cached issue presentation fields
- report artifacts

Where possible, switch those decisions to authoritative state plus fresh reads from Linear or
Codex.

### 3. Strengthen restart-focused tests

Add tests for cases like:

- queued turn input survives restart and is still deliverable
- reconciliation works when thread event history is absent
- stale cached issue metadata does not break restart decisions
- Linear moved on while PatchRelay was down

## Non-Goals

- no schema redesign
- no removal of SQLite as the harness ledger
- no large service/module split
- no broad refactor of reporting or CLI output

## Acceptance Criteria

- restart behavior is clearly driven by authoritative state
- reconciliation tests cover the important edge cases
- the PR keeps scope tighter than the harness-boundaries PR
- `npm run lint`, `npm run check`, and `npm test` pass

## Suggested Title

`Harden restart reconciliation around authoritative state`
