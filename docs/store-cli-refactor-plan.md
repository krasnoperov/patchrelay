# Store And CLI Refactor Plan

## Why This Refactor

Two large modules are carrying more responsibility than their names suggest:

- `src/db/issue-workflow-store.ts` mixes authoritative ledger writes, derived artifact writes, and
  query model assembly.
- `src/cli/index.ts` mixes argument parsing, command routing, dependency setup, command
  orchestration, polling loops, and output formatting.

PatchRelay already has the right architectural direction for this cleanup:

- `docs/module-map.md` keeps coordination, persistence, and observability as separate layers.
- `docs/state-authority.md` and `docs/persistence-audit.md` classify `issue_control`,
  `workspace_ownership`, `run_leases`, and `event_receipts` as authoritative, while
  `issue_projection`, `run_reports`, and event history remain derived or artifact-like.
- `src/db/authoritative-ledger-store.ts` already exists and covers the authoritative tables that
  `IssueWorkflowStore` still partially owns.

The goal is to finish that split in small steps rather than introducing a new architecture.

## Status

Implemented on `design/store-cli-separation-plan`:

- `IssueProjectionStore` and `RunReportStore` now own derived projection and report persistence
- `IssueWorkflowStore` is reduced to the read/query facade
- `src/db/issue-workflow-coordinator.ts` now owns workflow mutation orchestration
- CLI command families are extracted out of `src/cli/index.ts` for setup, connect, project, and
  issue-facing commands

Remaining cleanup is mostly opportunistic rather than structural.

## Goals

- Keep SQLite focused on authoritative harness coordination state.
- Move projection and artifact concerns behind narrow interfaces.
- Reduce duplicate SQL and duplicate state assembly paths.
- Shrink `runCli` into a thin entrypoint with command handlers.
- Preserve current behavior and test coverage during the migration.

## Big Plan

This refactor is best treated as a staged boundary-tightening effort rather than a single rewrite.
The higher-level plan is:

1. split derived persistence concerns away from mixed workflow storage
2. converge authoritative writes on the ledger store
3. introduce a small workflow coordinator for multi-table state transitions
4. extract CLI commands into focused handlers until `runCli` becomes dispatch-only
5. simplify `CliDataAccess` to consume the new boundaries instead of stitching legacy and ledger
   views together
6. optionally unify CLI and HTTP read-side assembly if duplication still remains after the boundary
   cleanup

The expected end state is:

- one clear write owner for authoritative coordination state
- one clear home for derived projections and reports
- one small orchestration surface for workflow state transitions
- one lightweight CLI entrypoint with narrow command modules
- one read-side composition path that can serve operator CLI and HTTP inspection consistently

## Non-Goals

- No persistence reclassification beyond what `docs/state-authority.md` already establishes.
- No schema redesign is required for the first phase.
- No broad rename or folder churn that makes blame history harder to follow.
- No rewrite of CLI formatting output unless a handler extraction needs a small adjustment.

## Current Boundary Problems

### `IssueWorkflowStore`

Today this class does all of the following:

- updates `issue_projection`
- updates `issue_control`
- updates `workspace_ownership`
- inserts and updates `run_leases`
- inserts `run_reports`
- synthesizes `TrackedIssueRecord`, `WorkspaceRecord`, `PipelineRunRecord`, and `StageRunRecord`
- performs multi-table transactional workflow actions such as `claimStageRun`

That creates two problems:

1. authoritative writes are duplicated with `src/db/authoritative-ledger-store.ts`
2. read-side models are tightly coupled to write-side orchestration

### `runCli`

Today `runCli` does all of the following:

- parses arguments
- resolves shorthand commands
- chooses config load profiles
- creates data access dependencies
- runs bootstrap/service-management workflows
- runs issue inspection commands
- implements polling loops for `live`, `events`, and OAuth connect
- formats final output and exit codes

That makes it hard to test individual commands, add new commands cleanly, or reason about
dependencies per command.

## Target Shape

### Store Split

#### 1. Keep authoritative tables behind `AuthoritativeLedgerStore`

Continue using `src/db/authoritative-ledger-store.ts` as the single writer for:

- `event_receipts`
- `issue_control`
- `workspace_ownership`
- `run_leases`
- `obligations`

If a method primarily exists to mutate those tables, it should not live in
`IssueWorkflowStore`.

#### 2. Extract derived stores

Add small stores for the derived surfaces:

- `src/db/issue-projection-store.ts`
- `src/db/run-report-store.ts`

Suggested responsibilities:

- `IssueProjectionStore`
  - `upsertIssueProjection`
  - `getIssueProjection`
  - `getIssueProjectionByKey`
  - `getIssueProjectionByLinearIssueId`
- `RunReportStore`
  - `saveRunReport`
  - `getRunReport`

#### 3. Convert `IssueWorkflowStore` into a read-oriented facade

After extraction, `IssueWorkflowStore` should mostly become a query assembler over:

- `AuthoritativeLedgerStore`
- `IssueProjectionStore`
- `RunReportStore`

Responsibilities that can stay in a read-oriented facade:

- `getTrackedIssue`
- `getTrackedIssueByKey`
- `getTrackedIssueByLinearIssueId`
- `getIssueOverview`
- `getLatestStageRunForIssue`
- `listStageRunsForIssue`
- `getStageRun`
- `getStageRunByThreadId`
- `getWorkspace`
- `getActiveWorkspaceForIssue`
- `getPipelineRun`

This keeps existing callers stable while the new lower-level stores take over ownership.

#### 4. Move multi-table workflow mutations into a coordinator

Methods such as these are better treated as coordination actions than as table ownership:

- `recordDesiredStage`
- `claimStageRun`
- `finishStageRun`
- `setIssueDesiredStage`
- `setIssueLifecycleStatus`
- `setIssueStatusComment`
- `setIssueActiveAgentSession`

Introduce a small coordinator service, for example:

- `src/db/issue-workflow-coordinator.ts`

Suggested responsibilities:

- compose ledger and artifact stores inside transactions
- expose intent-based operations
- keep persistence details out of service and CLI call sites

Suggested interface:

```ts
interface IssueWorkflowCoordinator {
  recordDesiredStage(...): TrackedIssueRecord;
  claimStageRun(...): ClaimStageRunResult | undefined;
  finishStageRun(...): void;
  setIssueLifecycleStatus(...): void;
  setIssueStatusComment(...): void;
  setIssueActiveAgentSession(...): void;
}
```

This keeps the orchestration decision close to the harness while removing it from the read model.

### CLI Split

#### 1. Keep `runCli` as a thin shell

Target responsibilities for `src/cli/index.ts`:

- parse argv
- resolve command name
- build `CliContext`
- dispatch to a handler
- map thrown errors to stderr + exit code

#### 2. Introduce explicit command interfaces

Add:

- `src/cli/args.ts`
- `src/cli/command-types.ts`
- `src/cli/context.ts`
- `src/cli/registry.ts`

Suggested interface:

```ts
export interface CliCommandHandler {
  readonly name: string;
  readonly configProfile: ConfigLoadProfile;
  run(context: CliContext, input: ParsedCommand): Promise<number>;
}
```

Suggested `CliContext` fields:

- `stdout`
- `stderr`
- `runInteractive`
- `openExternal`
- `connectPollIntervalMs`
- `loadConfig(profile)`
- `createDataAccess(config)`

#### 3. Extract handlers by command family

Create one module per command or per tight command family:

- `src/cli/commands/help.ts`
- `src/cli/commands/init.ts`
- `src/cli/commands/install-service.ts`
- `src/cli/commands/restart-service.ts`
- `src/cli/commands/project-apply.ts`
- `src/cli/commands/connect.ts`
- `src/cli/commands/installations.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/commands/inspect.ts`
- `src/cli/commands/live.ts`
- `src/cli/commands/report.ts`
- `src/cli/commands/events.ts`
- `src/cli/commands/worktree.ts`
- `src/cli/commands/open.ts`
- `src/cli/commands/retry.ts`
- `src/cli/commands/list.ts`

The highest-value extractions are:

1. `project apply`
2. `connect`
3. issue inspection commands (`inspect`, `live`, `report`, `events`, `worktree`, `open`, `retry`, `list`)

#### 4. Keep shared helpers in dedicated modules

Move reusable helper logic out of the entrypoint:

- `src/cli/service-commands.ts`
  - `installServiceCommands`
  - `restartServiceCommands`
  - `runServiceCommands`
  - `tryManageService`
- `src/cli/connect-flow.ts`
  - `runConnectFlow`
- `src/cli/open-command.ts`
  - `buildOpenCommand`
- `src/cli/output.ts`
  - `writeOutput`
  - small shared human-readable helpers like `formatDoctor`

This makes handlers easier to read without forcing inheritance or framework-heavy abstractions.

## Recommended Migration Sequence

## Phase Roadmap

### Phase 1: Derived Store Extraction

Purpose:

- separate `issue_projection` and `run_reports` from the mixed workflow store

Scope:

- add `IssueProjectionStore`
- add `RunReportStore`
- rewire `IssueWorkflowStore` to delegate to them

Status:

- in progress
- branch work already includes initial `IssueProjectionStore` and `RunReportStore` extraction

### Phase 2: Ledger Convergence

Purpose:

- make `AuthoritativeLedgerStore` the single write owner for authoritative coordination tables

Scope:

- stop duplicating `issue_control`, `workspace_ownership`, and `run_leases` SQL in
  `IssueWorkflowStore`
- ensure issue workflow state transitions route through ledger-owned methods

Status:

- in progress
- branch work already rewires `IssueWorkflowStore` onto the ledger for most active paths

### Phase 3: Workflow Coordinator

Purpose:

- move multi-table workflow transitions out of the query facade

Scope:

- introduce `IssueWorkflowCoordinator`
- move intent-style methods such as `recordDesiredStage`, `claimStageRun`, and `finishStageRun`
  into that coordinator
- keep query assembly in `IssueWorkflowStore`

Status:

- not started

### Phase 4: CLI Infrastructure

Purpose:

- stop treating `runCli` as the implementation surface for every command

Scope:

- extract argument parsing and shared helpers
- extract operator/bootstrap command modules
- preserve `runCli` as public entrypoint and black-box test surface

Status:

- substantially complete
- branch work already includes shared helper modules and extracted handlers for setup, connect,
  installations, and project apply

### Phase 5: Issue Command Extraction

Purpose:

- finish shrinking `runCli` by moving the issue-facing operator commands out

Scope:

- extract:
  - `inspect`
  - `live`
  - `report`
  - `events`
  - `worktree`
  - `open`
  - `retry`
  - `list`
- keep formatting behavior unchanged

Status:

- in progress
- branch work already includes extracted handlers for:
  - `inspect`
  - `live`
  - `report`
  - `events`
  - `worktree`
  - `open`
  - `retry`
  - `list`

### Phase 6: Read-Side Simplification

Purpose:

- reduce duplicate state synthesis between `CliDataAccess`, `IssueWorkflowStore`, and
  `IssueQueryService`

Scope:

- simplify `CliDataAccess` to consume the new split boundaries
- optionally share read-side assembly where it reduces duplication without muddying ownership

Status:

- not started

### Phase 7: Cleanup And Merge

Purpose:

- tighten the final interfaces and remove transitional duplication before merge

Scope:

- prune leftover compatibility methods if no longer needed
- update docs to reflect the final boundaries
- run full repo verification

Status:

- not started

### PR 1: Extract projection and report stores

- add `IssueProjectionStore`
- add `RunReportStore`
- rewire `IssueWorkflowStore` internals to delegate to them
- keep public behavior the same

Expected result:

- no caller changes outside the store layer
- derived storage gets clear ownership

### PR 2: Move authoritative write paths off `IssueWorkflowStore`

- replace duplicated `issue_control`, `workspace_ownership`, and `run_leases` writes with calls to
  `db.authoritativeLedger`
- introduce `IssueWorkflowCoordinator` for the multi-table methods
- leave `IssueWorkflowStore` focused on query assembly

Expected result:

- one authoritative implementation for ledger tables
- lower risk of behavior drift between stores

### PR 3: Simplify `CliDataAccess` around the new boundaries

- stop mixing direct ledger writes with `issueWorkflows` mutations
- keep `CliDataAccess` on clear seams:
  - query operations through `issueWorkflows` or a future query service
  - mutation operations through the coordinator / ledger

Expected result:

- less transitional glue such as mirrored stage-run synthesis
- easier unit testing of CLI data operations

### PR 4: Extract CLI handler infrastructure

- add `args.ts`, `command-types.ts`, `context.ts`, `registry.ts`
- shrink `runCli` to dispatch logic
- move `project apply` first

Expected result:

- lower cognitive load in the entrypoint
- better per-command dependency control

### PR 5: Extract remaining CLI commands

- move issue-facing commands into separate handlers
- move connect/installations/doctor into separate handlers
- keep formatter modules unchanged unless a small fix is needed

Expected result:

- new commands become additive
- tests can focus on each handler or keep using `runCli` as a stable public contract

### Optional PR 6: Unify read-side query assembly

There is already overlap between `CliDataAccess` and `src/issue-query-service.ts`.
Once the store split is done, consider a shared read-side service for:

- issue overview
- report lookup
- stage event lookup
- active stage status

This is optional and should only happen if duplication remains costly after the earlier PRs.

## Test Strategy

- Keep existing black-box CLI tests centered on `runCli`.
- Add focused store tests for:
  - projection store
  - run report store
  - coordinator transaction behavior
- Add focused handler tests for:
  - `project apply`
  - `connect`
  - one representative issue command such as `open` or `retry`

The refactor should preserve behavior before attempting output or semantics cleanup.

## Merge Gates

This branch is ready to merge only when all of the following are true:

- `npm run check` passes
- targeted CLI and workflow tests pass after each extraction step
- final pre-merge verification runs at least:
  - `npm run check`
  - `npm test`
- `IssueWorkflowStore` no longer acts as both mixed write owner and query facade
- `runCli` is primarily dispatch, dependency setup, and top-level error handling
- the remaining transitional duplication is either removed or intentionally documented

Until those gates are met, this branch should be treated as an active refactor branch and merged
only when the next coherent checkpoint is ready.

## Current Branch Status

At the current checkpoint, this branch already includes:

- initial derived-store extraction for `issue_projection` and `run_reports`
- a rewritten `IssueWorkflowStore` that delegates more of its storage concerns outward
- extracted CLI support modules for args, output, interactive helpers, connect flow, and service
  commands
- extracted CLI command handlers for setup/bootstrap commands, project apply, connect, and
  installations
- extracted CLI command handlers for the main issue-facing commands

The highest-value next implementation step is:

- introduce the workflow coordinator so the store split can be completed cleanly
- then simplify `CliDataAccess` to consume that coordinator instead of bridging legacy and ledger
  state directly

## Risks And Guardrails

- Do not let the new coordinator become another “god object”.
  Keep it limited to multi-table workflow actions.
- Do not move repo-specific workflow policy into persistence helpers.
  Policy should remain in the existing workflow and coordination layers.
- Do not make `issue_projection` or `run_reports` required for restart correctness.
  Query paths should tolerate missing derived data.
- Prefer compatibility wrappers and delegation over big-bang call-site rewrites.

## Done Criteria

This refactor is complete when:

- authoritative tables have one write owner
- `IssueWorkflowStore` is query-oriented or removed
- `runCli` is mostly dispatch and error handling
- `project apply` and at least the main issue commands live in separate handler modules
- tests still cover the current operator flows end to end
