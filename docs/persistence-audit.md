# PatchRelay Persistence Audit

This audit applies the decision rule from `docs/state-authority.md` to the current persistent
surfaces in PatchRelay. The goal is to classify what the harness must own for correctness versus
what it stores for observability and operator ergonomics.

## Summary

PatchRelay should continue to treat SQLite as the harness ledger, not as a second source of truth
for Linear, Codex, or the filesystem.

The current storage story is mostly healthy:

- active ownership and coordination state is authoritative
- OAuth and installation state is authoritative
- queued turn input is authoritative until delivered
- thread event history and rendered inspection data are mostly derived artifacts

## Audit Matrix

| Surface | Classification | Why it exists |
| --- | --- | --- |
| `webhook_events.webhook_id`, dedupe, processing status | Authoritative | PatchRelay must know whether a delivery was already accepted and how far processing got |
| `webhook_events.payload_json`, `headers_json` | Derived artifact | Useful for inspection and replay, but not the primary source of webhook truth after acceptance |
| `tracked_issues` active ownership fields | Authoritative | They bind an issue to the worktree, pipeline, stage, and thread PatchRelay currently owns |
| `tracked_issues` cached issue title, key, URL, last seen state | Mostly derived cache | Helpful for CLI/operator views and routing context, but Linear still owns these facts upstream |
| `workspaces` | Authoritative | PatchRelay owns durable issue worktree and branch correlation |
| `pipeline_runs` | Authoritative | They express the harness lifecycle PatchRelay is responsible for coordinating |
| `stage_runs` active state and thread correlation | Authoritative | Restart recovery and deterministic handoff depend on them |
| `stage_runs.summary_json`, `report_json` | Derived artifact | These can be rebuilt from thread history plus recorded events when needed |
| `thread_events` | Derived artifact | Valuable for debugging and reporting, but not the primary source of thread history |
| `queued_turn_inputs` before delivery | Authoritative | Undelivered operator input affects correctness and restart safety |
| `queued_turn_inputs` after delivery timestamp | Historical artifact | Useful for traceability, but no longer needed for coordination |
| `linear_installations`, `project_installations`, `oauth_states` | Authoritative | PatchRelay owns installation linkage, token storage, and OAuth flow safety |

## Concrete Guidance

### Keep authoritative in SQLite

- webhook dedupe and processing state
- active issue ownership and stage ownership
- active issue-to-thread correlation
- undelivered queued turn input
- installation, token, and OAuth state

### Treat as cache or artifact

- thread event history
- rendered reports and summaries
- cached issue presentation fields
- archived webhook payload bodies beyond the minimum dedupe index

## Near-Term Implications

The next modest cleanups should follow this order:

1. clarify store interfaces where authoritative coordination state and event history are mixed
2. strengthen reconciliation tests so authoritative state is protected by behavior checks
3. avoid broad schema removals until an operational pain point appears

The right next move is sharper boundaries, not less persistence for its own sake.
