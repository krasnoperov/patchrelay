# GitHub Queue Contract

PatchRelay and Merge Steward are intentionally decoupled services. GitHub is the protocol boundary between them.

This document is the contract for that boundary.

## Shared Primitives

- Repository: `repoFullName`
- Base branch: `baseBranch`
- Pull request identity: `prNumber`, branch name, `headSha`, `baseSha`
- Review state: approved, changes requested, commented
- Check state: passed, failed, pending
- Merge state: open, closed, merged

## Shared Control Artifacts

- Eviction check run:
  Merge Steward emits this on queue eviction.
  PatchRelay interprets it as a queue-repair request rather than ordinary CI failure.
  Default: `merge-steward/queue`

- Optional compatibility label:
  Some repos may still carry a `queue` label or similar metadata.
  PatchRelay does not rely on it for scheduling, and Merge Steward admission should not require it.

## Ownership

- PatchRelay owns:
  - branch implementation
  - review fixes
  - branch-local CI repair
  - queue repair after steward eviction
  - Linear-facing operator and session UX

- Merge Steward owns:
  - queue admission
  - branch freshness
  - validation retries
  - merge execution
  - eviction classification and incident creation

## Required GitHub Events

- PatchRelay:
  - `pull_request`
  - `pull_request_review`
  - `check_suite`
  - `check_run`
  - `push`

- Merge Steward:
  - `pull_request`
  - `pull_request_review`
  - `check_suite`
  - `push`

## Failure Contract

- Ordinary branch CI failure:
  - produced by normal PR checks
  - PatchRelay routes to `ci_repair`

- Queue eviction:
  - produced by Merge Steward as the configured eviction check run
  - PatchRelay routes to `queue_repair`
  - PatchRelay persists queue-failure provenance so reconciliation can preserve the distinction after webhook delivery
  - the eviction check run should carry structured incident detail in `output.text` plus an incident details URL so PatchRelay can preserve richer repair context

## Observability Contract

- PatchRelay should expose:
  - configured eviction check name
  - last observed queue/failure signal

- Merge Steward should expose:
  - incident detail for evicted entries
  - emitted eviction check run name
  - current required checks / admission facts from GitHub truth

## Defaults

- Eviction check run: `merge-steward/queue`

Changing the eviction check name must be treated as a protocol change and updated on both sides.
