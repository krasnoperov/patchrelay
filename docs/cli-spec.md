# PatchRelay CLI Specification

## Purpose

`patchrelay` is a terminal-first operator utility for inspecting and following PatchRelay issue pipelines without using the browser endpoints directly.

The CLI is not a second orchestrator.

It is a local inspection and control surface over:

- PatchRelay's SQLite orchestration database
- PatchRelay's local HTTP endpoints
- the local filesystem worktrees already created for issues

Its first job is observability:

- tell an operator what stage an issue is in
- show what Codex is currently doing
- replay what happened after a stage finishes
- jump directly into the correct worktree

Its second job is light operator control:

- re-trigger a stage
- tail live activity
- open the right workspace path

## User goals

The CLI must let an operator answer these questions quickly:

- Is `USE-54` running right now?
- Which stage is active?
- What is the latest assistant message?
- Which commands ran?
- Which files changed?
- Why did a stage fail?
- Which worktree should I open?
- What thread or stage should I inspect?

The CLI must work well over SSH and in a plain terminal.

## Design principles

1. Prefer local data over remote dependencies.
2. Prefer read-only inspection by default.
3. Keep commands predictable and grep-friendly.
4. Make the "right path" obvious for a human takeover.
5. Expose both concise summaries and raw evidence.

## Scope

Initial scope:

- issue overview
- live stage status
- completed stage reports
- raw stage events
- worktree path and branch inspection
- simple retry/requeue control

Out of scope for the first version:

- editing Linear issues directly
- replacing the web API
- rendering a full-screen ncurses TUI
- becoming a generic Codex client outside PatchRelay-managed issues

## Invocation model

Primary entrypoint:

```bash
patchrelay <command> [args] [flags]
```

Default behavior:

```bash
patchrelay inspect USE-54
```

This should be the "do the sensible thing" command.

## Data model

The CLI reads these entities:

- tracked issue
- workspace
- pipeline run
- stage run
- thread events
- synthesized stage report

Primary keys exposed to users:

- issue key, for example `USE-54`
- optional stage run id

Internal ids such as pipeline ids and thread ids may be displayed, but users should not need them for common tasks.

## Command set

### `patchrelay inspect <issueKey>`

Show a compact issue summary.

Output includes:

- issue key and title
- current Linear state
- lifecycle status
- active stage, if any
- latest completed stage
- workspace path
- branch name
- latest thread id
- latest turn id
- high-level status note

If the issue is active, also include:

- latest live assistant message
- latest turn status

This command should be short enough to use constantly.

### `patchrelay live <issueKey>`

Show the current live view of the active stage.

Output includes:

- stage
- thread id
- turn id
- current turn status
- latest assistant message
- latest timestamp seen

Flags:

- `--json`
- `--watch`

`--watch` refreshes every 2 seconds until the stage completes or the user exits.

### `patchrelay report <issueKey>`

Show completed stage reports for the issue.

Default output:

- one section per stage run
- status
- summary
- assistant conclusion
- commands run
- changed files
- tool calls
- failure note, if any

Flags:

- `--stage <stage>`
- `--stage-run <id>`
- `--json`

### `patchrelay events <issueKey>`

Show raw stored app-server notifications for an issue.

Default behavior:

- use the active stage run if present
- otherwise use the latest stage run

Flags:

- `--stage-run <id>`
- `--follow`
- `--json`
- `--method <name>`

`--follow` behaves like `tail -f` over newly inserted `thread_events`.

This is the main debugging command when summaries are insufficient.

### `patchrelay worktree <issueKey>`

Print the workspace details for the issue.

Output includes:

- worktree path
- branch name
- repo id

Flags:

- `--cd`

`--cd` prints only the absolute worktree path so the command can be used in shells:

```bash
cd "$(patchrelay worktree USE-54 --cd)"
```

### `patchrelay open <issueKey>`

Print the exact human takeover command for the issue.

Example output:

```bash
cd /srv/patchrelay/worktrees/usertold/USE-54
git branch --show-current
codex
```

If a resumable PatchRelay-managed thread id exists, also print:

```bash
codex resume <threadId>
```

This command is informational. It does not spawn a subshell.

### `patchrelay retry <issueKey>`

Requeue the current stage for an issue.

Behavior:

- only allowed when there is no active stage run
- reuses the current Linear-mapped desired stage if possible
- otherwise requires `--stage`

Flags:

- `--stage <development|review|deploy|cleanup>`
- `--reason <text>`

This command should update PatchRelay state, not mutate git state.

### `patchrelay list`

List tracked issues known to PatchRelay.

Default columns:

- issue key
- Linear state
- lifecycle status
- active stage
- latest stage result
- updated time

Flags:

- `--active`
- `--failed`
- `--project <projectId>`
- `--json`

## Output modes

Every inspection command should support:

- human-readable text output by default
- machine-readable `--json`

Human mode should be concise and structured for terminals.

JSON mode should be stable enough for scripting and shell pipelines.

## Transport strategy

The CLI should prefer direct local DB access for fast local reads.

Recommended read paths:

- DB for issue/workspace/pipeline/stage metadata
- DB for raw `thread_events`
- DB for stored `report_json`

Optional live augmentation:

- use local HTTP or a shared service helper for the current live summary when needed

Rationale:

- DB access is simple, fast, and avoids extra HTTP dependencies
- live status may still benefit from the service's existing thread-read logic

The CLI should not speak JSON-RPC to `codex app-server` directly in the first version.

PatchRelay already owns that relationship.

## UX details

### Human-readable style

Example:

```text
USE-54  Human Needed
Title: Redesign session detail page into a playback-first minimal evidence workspace
Workspace: /srv/patchrelay/worktrees/usertold/USE-54
Branch: usertold/USE-54-redesign-session-detail-page-into-a-playback-first-minimal-e

Latest stage: deploy
Result: completed
Outcome: human needed

Latest assistant message:
Deploy did not complete. I moved USE-54 to Human Needed because the branch is ready, but the supported stage deploy path failed on environment auth.
```

### Failure ergonomics

When a stage failed, the CLI must surface:

- failure type
- failure message
- last known thread id
- whether the failure happened before thread creation or during a live turn

### Human takeover ergonomics

When an issue is paused or human-needed, `patchrelay inspect` and `patchrelay open` should prominently show:

- worktree path
- branch name
- last thread id
- last completed stage

## Implementation phases

### Phase 1

- `inspect`
- `live`
- `report`
- `events`
- `worktree`
- `open`

### Phase 2

- `list`
- `retry`
- `--watch`
- `--follow`

### Phase 3

- simple full-screen TUI mode
- keyboard navigation between issues and stages
- split-pane live event viewer

## Internal architecture

Suggested modules:

- `src/cli/index.ts`
- `src/cli/commands/inspect.ts`
- `src/cli/commands/live.ts`
- `src/cli/commands/report.ts`
- `src/cli/commands/events.ts`
- `src/cli/commands/worktree.ts`
- `src/cli/commands/open.ts`
- `src/cli/commands/retry.ts`
- `src/cli/formatters/text.ts`
- `src/cli/formatters/json.ts`
- `src/cli/data.ts`

`src/cli/data.ts` should be the only place that knows how to read:

- the SQLite database
- optional live-service helpers

## Acceptance criteria

The first usable CLI version is done when:

1. `patchrelay inspect USE-54` shows current issue, stage, workspace, and latest summary
2. `patchrelay live USE-54` shows current live status without requiring the browser
3. `patchrelay report USE-54` shows completed stage summaries
4. `patchrelay events USE-54` shows raw app-server event rows for debugging
5. `patchrelay worktree USE-54 --cd` prints only the worktree path
6. `patchrelay open USE-54` gives a correct manual takeover path
7. every command supports `--json`
8. failures are understandable without opening SQLite manually

## Future extension

If terminal usage becomes heavy, the CLI can later grow into a real TUI.

At that point, the same command model should still exist underneath it.

The TUI should be layered on top of the CLI data API, not replace it.
