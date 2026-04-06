# Operator State Visualization

## Purpose

This document defines how operator-facing UIs should present workflow state for:

- PatchRelay issue execution
- merge-steward queue execution

The goal is to make progress legible without collapsing the boundary between the two systems.

## Boundary Rule

PatchRelay and merge-steward are independent services.
They do not share a lifecycle state machine.
GitHub is the shared bus.

Operator surfaces must therefore separate:

- native state: what the current service owns directly
- external observation: what the current service has inferred from GitHub events, checks, or branch changes

Do not invent cross-service states such as `queued_in_steward`.

## PatchRelay

### Native States

PatchRelay's native issue lifecycle is the `FactoryState` union in `src/factory-state.ts`:

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

### Native Graph

The PatchRelay dashboard should render a compact native-state graph for the selected issue.

Main path:

```text
delegated -> implementing -> pr_open -> awaiting_queue -> done
```

Loop states:

- `changes_requested` branches from `pr_open`
- `repairing_ci` branches from `pr_open`
- `repairing_queue` branches from `awaiting_queue`

Terminal exits:

- `awaiting_input`
- `escalated`
- `failed`

The graph should show:

- current node
- previously visited nodes
- unvisited nodes

### External Queue Observation

The PatchRelay dashboard should show a separate `Queue Observation` block beside or below the native graph.

This block is derived from:

- issue metadata
- GitHub feed events
- queue-repair run status

It should answer:

- has PatchRelay handed the PR off yet
- what external queue fact was most recently observed
- why PatchRelay resumed work, if it did

Example observations:

- `waiting for external queue progress`
- `external queue reported failure via merge-steward/queue`
- `queue repair run active`
- `PR merged in GitHub`

## merge-steward

### Native States

merge-steward's native queue-entry lifecycle is the `QueueEntryStatus` union in `packages/merge-steward/src/types.ts`:

- `queued`
- `preparing_head`
- `validating`
- `merging`
- `evicted`
- `merged`
- `dequeued`

### Multi-PR Representation

merge-steward handles several PRs at once as an ordered queue, but only one head advances at a time.

The top-level dashboard view must therefore remain a queue list.
It should prioritize:

- queue order
- which PR is head-of-line
- each entry's native status
- recent queue-wide events

### Per-Entry Graph

The selected entry detail view should render a native-state graph for that one PR:

```text
queued -> preparing_head -> validating -> merging -> merged
```

Exit nodes:

- `evicted`
- `dequeued`

The graph should show:

- current node
- previously visited nodes
- whether the entry is waiting behind the head or is the active head

### External Repair Observation

merge-steward detail should show a separate `External Repair Observation` block.

This block is derived from:

- incidents
- transition events
- branch generation and head changes

It should answer:

- whether the steward expects outside repair
- what failure class caused that expectation
- whether a later branch update suggests outside work happened

Example observations:

- `head-of-line; steward can advance this PR`
- `waiting behind the current head`
- `evicted after retry budget exhaustion`
- `latest failure class: integration_conflict`
- `branch head changed since first admission`

## UI Layout

### PatchRelay dashboard detail

Recommended structure:

1. issue header
2. native state graph
3. queue observation block
4. existing plan, timeline, or history view

The graph and observation block should appear in the history-oriented detail view, where operators are trying to understand progression rather than live transcript flow.

### merge-steward watch

Recommended structure:

1. queue list as the primary top-level view
2. recent queue-wide events below the list
3. selected-entry detail with:
   - header
   - native entry graph
   - external repair observation block
   - incidents
   - transition events

## Interaction Rules

- Do not rename native states into cross-system shorthand in detailed views.
- If shorthand is used in list rows, detail views must still show the exact native state names.
- Every observation line should explain either `what happened`, `what system observed it`, or `what needs to happen next`.
- When a transition reason is known, prefer a concrete explanation over a generic label.
