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
- queued obligations are authoritative until delivered
- reports, projections, and thread event history are derived artifacts

## Audit Matrix

| Surface | Classification | Why it exists |
| --- | --- | --- |
| `webhook_events.webhook_id`, dedupe, processing status | Authoritative | PatchRelay must know whether a delivery was already accepted and how far processing got |
| `webhook_events.payload_json`, `headers_json` | Derived artifact | Useful for inspection and replay, but not the primary source of webhook truth after acceptance |
| `event_receipts` | Authoritative | PatchRelay owns accepted webhook identity, dedupe correlation, and trigger linkage |
| `issue_control` | Authoritative | It binds an issue to desired stage, active run, active workspace, and service-owned lifecycle state |
| `workspace_ownership` | Authoritative | PatchRelay owns durable issue worktree and branch correlation |
| `issue_sessions` | Authoritative | PatchRelay owns the issue-to-session handoff history needed to reopen the right Codex session |
| `run_leases` active state and thread correlation | Authoritative | Restart recovery and deterministic handoff depend on them |
| `obligations` before completion | Authoritative | Undelivered operator input affects correctness and restart safety |
| `issue_projection` | Derived projection | Helpful for CLI/operator views and routing context, but Linear still owns these facts upstream |
| `run_reports` | Derived artifact | These can be rebuilt from thread history plus recorded completion state when needed |
| `run_thread_events` | Derived artifact | Valuable for debugging and reporting, but not the primary source of thread history |
| `linear_installations`, `project_installations`, `oauth_states` | Authoritative | PatchRelay owns installation linkage, token storage, and OAuth flow safety |

## Concrete Guidance

### Keep authoritative in SQLite

- webhook dedupe and processing state
- active issue ownership and stage ownership
- issue-to-session handoff history for operator reopen flows
- active issue-to-thread correlation
- undelivered queued obligations
- installation, token, and OAuth state

### Treat as cache or artifact

- thread event history
- rendered reports and summaries
- cached issue presentation fields in projections
- archived webhook payload bodies beyond the minimum dedupe index

## Near-Term Implications

The right next move is sharper boundaries between ledger ports and projection/artifact ports, not
reintroducing mixed legacy workflow tables.
