# Durable Agent Workflow Runtime

## Summary

PatchRelay v2 should be a durable agent workflow runtime, not a Linear bot or a GitHub webhook handler.

Connectors append observations. Projectors build workflow snapshots. Planners derive tasks. Gates enforce safety. Executors perform work and report results back into the log.

```text
Connectors -> Observation Log -> Workflow Runtime -> Executors
```

The runtime should stay integration-agnostic. Linear, GitHub, Git, and operator CLI behavior should live behind connectors and capabilities.

## Motivation

PatchRelay's hardest failures are not simple webhook routing failures. They are failures of durable workflow truth:

- the service restarts while work is active,
- events arrive out of order,
- external state changes while an agent is working,
- PatchRelay acts without current authority,
- work appears complete without evidence,
- human input is ambiguous but still triggers work.

The v1 core encodes too much into factory states. States such as `changes_requested`, `awaiting_queue`, and `repairing_ci` mix human-facing display, routing, authority, retry memory, and GitHub truth.

The v2 core should unmix these concerns.

## Mental Model

PatchRelay v2 has four layers:

```text
          +------------+
Linear -->|            |
GitHub -->| Connectors |
CLI    -->|            |
          +-----+------+
                |
                v
          +------------+
          | Observation|
          |    Log     |
          +-----+------+
                |
                v
          +------------+
          | Projector  | --> Snapshot
          +-----+------+
                |
                v
          +------------+
          |  Planner   | --> Tasks
          +-----+------+
                |
                v
          +------------+
          |   Gates    | --> start / wait / ask / escalate
          +-----+------+
                |
                v
          +------------+
          | Executors  | --> result events
          +------------+
```

## Core Vocabulary

### Event / Observation

An observed input or outcome.

Examples:

- Linear issue delegated.
- Linear user prompted the agent.
- GitHub review requested changes.
- GitHub check failed.
- Codex run completed.
- Git worktree is dirty.
- Operator requested retry.

```ts
interface WorkflowEvent {
  id: string;
  source: "linear" | "github" | "git" | "runner" | "operator";
  subjectId: string;
  type: string;
  payload: unknown;
  dedupeKey?: string;
  observedAt: string;
}
```

Connectors do not decide workflow. They only translate external inputs into events.

The log is not just a webhook log. It is an observation log fed by webhooks, startup reconciliation, periodic reconciliation, executor outcomes, local Git inspection, and operator actions.

### Snapshot

The current projected workflow state derived from events and reconciliation.

```ts
interface WorkflowSnapshot {
  id: string;
  status: WorkflowStatus;
  authority: WorkflowAuthority;
  context: Record<string, unknown>;
  openTasks: WorkflowTask[];
  activeRun?: WorkflowRun;
  artifacts: WorkflowArtifact[];
  externalRefs: ExternalRef[];
}
```

Snapshots are read models. They are convenient, but the durable source is the event log plus reconciled external facts.

### Task

Something the runtime currently needs done.

Examples:

- run implementation,
- run review fix,
- verify PR head advanced,
- ask human for missing input,
- wait for dependency,
- reconcile GitHub PR state,
- publish Linear activity,
- escalate.

```ts
type WorkflowTask =
  | { type: "run"; runType: "implementation" | "review_fix" | "ci_repair" | "queue_repair" | "branch_upkeep" }
  | { type: "verify"; artifact: string; condition: string }
  | { type: "ask"; question: string }
  | { type: "wait"; reason: string }
  | { type: "publish"; connector: string; message: string }
  | { type: "escalate"; reason: string };
```

Tasks are the only executor-admission vocabulary. An event does not directly start work; events update the snapshot, and the snapshot produces tasks.

The current task set is materialized as a durable read model. Reconciliation upserts the tasks the projector still wants and closes stale task rows when authority, blockers, PR state, or active-run state changes. Runnable executor work is therefore a query over current gated tasks, not a transient webhook side effect.

Startup and tick-time dispatch rebuild this read model before asking what can run. Executor admission reads open runnable workflow tasks only.

### Run

An active attempt to complete a task.

Runs are leased. A restarted service can reconcile active runs from the observation log, runner state, and connector truth.

```ts
interface WorkflowRun {
  id: string;
  taskId: string;
  executor: "codex" | "local";
  authorityEpoch: number;
  leaseId: string;
  status: "starting" | "running" | "completed" | "failed" | "released" | "revoked";
  startedAt: string;
  stoppedAt?: string;
}
```

### Artifact

A durable output or external object.

Examples:

- branch,
- commit,
- pull request,
- review,
- check run,
- Linear agent session,
- Codex thread.

### Authority

Authority is the current right to act on a workflow. For PatchRelay's Linear integration, delegation is the primary authority source, but Linear should not be treated as a distributed lock server.

```ts
interface WorkflowAuthority {
  delegated: boolean;
  epoch: number;
  source: "linear" | "operator";
  observedAt: string;
}
```

Runs are claimed under the current `authorityEpoch`. If authority changes while a run is active, the run's lease becomes stale and the runtime must revoke or release it.

### Gate

A rule that decides whether a task may start or complete.

Examples:

- Do not run without delegated authority.
- Do not start implementation while blockers are unresolved.
- Do not complete `review_fix` unless the PR head advanced past the blocking review SHA.
- Do not complete implementation without an open PR, unless a verifier confirms there is no code-delivery obligation.
- Do not treat ambiguous human text as work.

Gates should return explicit decisions:

```ts
type GateDecision =
  | { action: "start" }
  | { action: "wait"; reason: string }
  | { action: "ask"; reason: string; question: string }
  | { action: "escalate"; reason: string };
```

## Key Inversion

V1 often behaves like this:

```text
Webhook arrives -> decide state transition -> maybe enqueue run
```

V2 should behave like this:

```text
Observation arrives -> append event -> project snapshot -> derive tasks -> gates decide what may run
```

This makes restart recovery, idempotency, and reconciliation first-class.

## Observation And Reconciliation

Webhooks are not the runtime's truth source. They are one low-latency observation channel.

Connectors must also support reconciliation:

```ts
interface Connector {
  ingestWebhook(input: unknown): WorkflowEvent[];
  reconcileSubject(subjectId: string): Promise<WorkflowEvent[]>;
  reconcileRecent(window: ReconcileWindow): Promise<WorkflowEvent[]>;
}
```

Startup reconciliation:

```text
load active workflows
reconcile Linear issue, session, blockers, and authority
reconcile GitHub PR, reviews, checks, and merge state
reconcile executor runs
inspect local worktree
append observations
project snapshots
derive tasks
schedule safe work
```

Periodic reconciliation should sweep recent and active entities, not the whole external world.

The core assumption is not "PatchRelay receives every webhook." The core assumption is "PatchRelay can reconstruct current truth from connectors and append what it observes."

## Authority And Stop Contract

PatchRelay must be able to stop active agentic sessions when authority is revoked.

On undelegation:

```text
append linear.undelegated
increment authority epoch
revoke active run lease
interrupt executor
clear runnable execution tasks
publish paused state
```

A run may perform PatchRelay-mediated side effects only while:

```text
authority.delegated = true
run.authorityEpoch = authority.epoch
run lease is live
```

The runtime must check this before launch, before steering, before publishing side effects, and during finalization. If Codex completes after revocation, the finalizer ignores the output, blocks publish, and records the run as released or revoked.

This is a hard contract:

```text
1. durable lease is revoked,
2. executor receives interrupt,
3. pending execution tasks are cleared,
4. PatchRelay-mediated side effects are blocked,
5. later completion from the revoked run is ignored.
```

For a stronger guarantee, publication should move behind PatchRelay-owned capabilities instead of exposing reusable raw GitHub/Linear credentials to the executor:

```text
Codex edits and tests freely.
PatchRelay owns push, PR mutation, and Linear mutation.
Every publishing capability checks the live run lease.
```

Authority reconciliation should happen at meaningful control points:

- on startup,
- before starting a run,
- before publishing side effects,
- during normal periodic reconciliation,
- when Linear sends an authority-related webhook.

It should not be an aggressive lock-style poll loop against Linear.

## Example: Requested Changes

```text
GitHub review requested changes on head abc123
-> append event
-> snapshot says PR has blocking review on abc123
-> planner creates task: run review_fix
-> gate requires delegated authority + open PR + blocking head
-> Codex executor runs review_fix
-> executor reports completed
-> GitHub connector reconciles PR head
-> verifier gate checks head != abc123
-> if true: task complete
-> if false: escalate or retry
```

The important property is that completion depends on evidence, not on the agent saying it finished.

## Failure Cases

### Restart Or Missed Webhooks

Missed webhooks are normal. On restart, the runtime reconciles active and recent workflows from Linear, GitHub, executor state, and local Git state, then appends fresh observations and re-derives tasks.

If reconciliation discovers a pending PR review, red check, merge, undelegation, dirty worktree, or missing PR, that becomes an observation just like a webhook would have.

### Executor Problems

Codex is an executor, not a source of workflow truth.

Executor outcomes should map to runtime tasks:

```text
depleted limit -> wait/retry task with backoff
session disappeared -> recover or retry by budget
completed without PR -> verifier fails
dirty worktree -> continue-publish task
misbehavior -> verifier fails, retry or escalate
```

Executor completion means only "the attempt ended." Verifier gates decide whether the workflow advanced.

### Fast Delegation Churn

Delegation and undelegation update the workflow authority epoch. Any run started under an older epoch loses authority.

Late output from stale runs is ignored. Pending runnable tasks are cleared or re-derived from the new snapshot.

### Delegation Followed By Blockers

Delegation can create a possible implementation task, but start gates must refresh blocker state just in time.

```text
delegated event arrives
planner derives implementation task
start gate reconciles Linear dependencies
if blockers unresolved: task becomes wait(blocked)
if blockers clear: run may start
```

No implementation run should start from stale dependency truth.

### Umbrella Tasks

Umbrella workflows coordinate child workflows. They should not be Linear-specific hacks.

Parent workflow responsibilities:

- plan child workflows,
- create or update child issues,
- wait for child snapshots,
- aggregate child outcomes,
- ask a human when decomposition is ambiguous,
- complete only when child workflows satisfy the objective.

Child workflows own code delivery. Parent workflows own coordination.

### PR-Backed Issues

A pull request is an artifact attached to a workflow.

Reviewer comments:

```text
review_changes_requested -> review_fix task
completion requires current PR head != blocking review head
```

Red CI:

```text
settled branch CI failure -> ci_repair task
branch CI while awaiting queue -> metadata unless the queue evicts
merge-steward eviction -> queue_repair task
```

Sudden merge:

```text
github.pr_merged
-> cancel or suppress active repair tasks
-> block further publish
-> derive deploy/done task depending on project config
```

GitHub terminal truth wins over in-flight local work.

## Relation To Existing Systems

### LangGraph

LangGraph provides stateful agent workflows, persistence, interrupts, and resumability. PatchRelay's runtime should take a similar shape:

- state is explicit,
- transitions are explicit,
- human pauses are modeled as interrupts/tasks,
- execution can resume after a crash.

PatchRelay should be more domain-specific than a general graph runtime because code delivery has external proof obligations.

### Temporal

Temporal's relevant lesson is durable execution history:

- record meaningful events,
- replay or re-project state after restart,
- avoid relying on process memory for workflow truth.

PatchRelay does not need to become a Temporal workflow, but it should adopt the same discipline: commands and outcomes are durable events.

### Agents SDK

The Agents SDK provides useful executor-level primitives:

- agents,
- tools,
- handoffs,
- guardrails,
- sessions,
- tracing.

PatchRelay's runtime should sit above the agent executor:

```text
Runtime chooses task
Executor runs agent with tools and guardrails
Executor emits result event
Runtime verifies and advances
```

The runtime owns workflow truth. The agent executor owns task execution.

## Connector Responsibilities

Connectors translate between external systems and runtime events/tasks.

### Linear Connector

Responsibilities:

- ingest delegation, comments, prompts, stop requests, and issue state changes,
- publish agent-session activities,
- publish questions when the runtime has an `ask` task,
- reconcile issue authority, blockers, and session state.

Linear is the human-facing control plane. It is not the workflow kernel.

### GitHub Connector

Responsibilities:

- ingest PR, review, check, and merge events,
- reconcile PR state, checks, reviews, branches, and mergeability,
- publish PR links or comments when requested by tasks,
- provide evidence for verifier gates.

GitHub is the delivery-truth connector. It is not the workflow kernel.

### Git Connector

Responsibilities:

- inspect worktree state,
- compute branch/head facts,
- report dirty worktree or merge-in-progress evidence,
- provide local artifact facts for verification.

### Operator Connector

Responsibilities:

- ingest retry, pause, close, and manual intervention commands,
- expose workflow snapshots,
- surface tasks, waits, and escalations.

## Minimal Kernel Modules

```text
kernel/
  event-log.ts       append-only event storage and dedupe
  projector.ts       events + reconciled facts -> workflow snapshot
  planner.ts         snapshot -> tasks
  gates.ts           task admissibility and completion rules
  scheduler.ts       leased runnable task selection
  run-lifecycle.ts   create, launch, steer, finish, fail, recover runs
  reconciler.ts      periodic connector refresh and restart recovery
  artifacts.ts       durable artifact registry

connectors/
  linear/
  github/
  git/
  operator/

executors/
  codex/
  local/
```

## V1 Concepts To Preserve

The v1 implementation has valuable hard-won invariants:

- issue session events become the event log,
- the old dispatch shell becomes workflow-task dispatch,
- `commitIssueState` becomes projector/write transaction discipline,
- reactive run policies become verifier gates,
- run finalizer becomes run lifecycle,
- Linear and GitHub handlers become thin connectors,
- idle reconciliation becomes runtime reconciliation.

The v1 factory states should become connector-facing projections, not the core workflow model.

## Current Runtime

PatchRelay keeps the existing factory-state projection for UI and Linear sync, but executor admission reads durable workflow tasks:

```text
observations -> snapshot -> workflow_tasks -> runs -> projections
```

GitHub PR lifecycle repair now follows the v2 path. The GitHub connector records external failure or review provenance, appends a GitHub observation, reconciles workflow tasks, and dispatches the issue only if the reconciled task is runnable.

The connector does not append synthetic session inputs for branch-CI repair, merge-queue repair, or requested-changes review repair. Requested-changes observations carry review body, review identity, reviewer, review URL, and inline review comments when available; the `run:review_fix` task passes that context into the executor prompt.

## Design Principles

1. Connectors report observations; they do not own workflow decisions.
2. Webhooks never start work directly.
3. Every active run is tied to a task and a lease.
4. Every task has gates for start and completion.
5. Completion must be proven by artifacts or reconciled external truth.
6. Ambiguous human input should ask or wait, not silently start work.
7. Restart recovery is normal operation, not an exceptional path.
8. Human-facing states are projections, not durable workflow truth.

## Open Questions

- Should the event log be the only durable source, or should snapshots also be checkpointed?
- How much of the planner should be deterministic policy versus agent-assisted classification?
- Should verifier gates be pure functions over snapshots, or can they perform connector reads?
- What is the minimum event schema needed to migrate v1 issue-session events?
- How should connector-specific projections map to Linear workflow states?
- Should Codex threads be artifacts, runs, or both?

## One-Sentence North Star

PatchRelay v2 should be a durable workflow runtime where connectors append events, projectors build state, planners derive tasks, gates enforce safety, and executors report results back into the log.
