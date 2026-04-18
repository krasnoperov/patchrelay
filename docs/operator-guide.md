# PatchRelay Operator Guide

Day-to-day usage, command cheatsheet, and troubleshooting paths once PatchRelay is installed and linked to a repo.

For install and first-time setup, see [self-hosting.md](./self-hosting.md). For architecture, see [architecture.md](./architecture.md).

## Daily loop

1. Delegate a Linear issue to the PatchRelay app.
2. Linear sends delegation and agent-session webhooks to PatchRelay, which creates or reuses the issue worktree and launches an implementation run.
3. Follow up in the Linear agent session to steer the active run or wake it with fresh input while it remains delegated.
4. GitHub webhooks automatically trigger CI repair, review fix, or merge queue repair runs when needed.
5. Watch progress from the terminal, or open the same worktree and take over manually.

## Command cheatsheet

```bash
patchrelay dashboard                    # overview across all active issues
patchrelay issue list --active          # just the active ones, one line each
patchrelay issue show APP-123           # detail for one issue
patchrelay issue watch APP-123          # live-follow one issue
patchrelay issue path APP-123 --cd      # print the worktree path (or cd into it)
patchrelay issue open APP-123           # open a Codex CLI session in the worktree
patchrelay issue retry APP-123          # requeue after a failure
patchrelay service restart              # reload the service
patchrelay service logs --lines 100     # recent journal output
```

`patchrelay issue open` is the handoff bridge: it opens a normal Codex CLI session in the issue worktree and resumes the existing thread when PatchRelay has one. Today that takeover path is intentionally YOLO mode — it launches Codex with `--dangerously-bypass-approvals-and-sandbox`.

## Operator view — what state is durable

PatchRelay keeps enough persistent state to answer these questions during and after a run:

- which worktree and branch belong to an issue
- which run is active or queued
- which Codex thread owns the current work
- what the agent said
- which commands it ran
- which files it changed
- whether the run completed, failed, or needs handoff

This is why PatchRelay maintains `issues` and `runs` tables alongside Codex thread history and Linear state. The goal is not to duplicate the model transcript — it is to make automation restartable, inspectable, and recoverable when the process or machine is interrupted.

## When automation looks stuck

1. **`patchrelay dashboard`** — see active issues and waiting reasons across the service.
2. **`patchrelay issue show APP-123`** or **`patchrelay issue watch APP-123`** — inspect one issue in detail.
3. **`patchrelay issue open APP-123`** — take over inside the same worktree and continue from the same issue context.
4. **`patchrelay service logs --lines 100`** — when the problem looks like webhook intake, Codex startup, or service runtime failure.

### Where the logs live

- log file on disk: `~/.local/state/patchrelay/patchrelay.log`
- live systemd stream: `journalctl -u patchrelay.service -f`

Use the log file for persisted history, `journalctl` for the live stream.

### Common log patterns

| Symptom | Look for |
|-|-|
| Linear did nothing after a delegation or mention | Webhook intake lines — accepted, rejected, stale, or duplicate deliveries |
| Agent ignored a new Linear comment or prompt | Queued turn-input delivery lines and any delivery failure warnings |
| Codex execution looks broken or stops unexpectedly | `Starting Codex app-server`, `Codex app-server request failed`, `Codex app-server stderr`, `Codex app-server exited` |

The most useful correlation fields across logs: `webhookId`, `webhookEventId`, `projectId`, `issueKey`, `runType`, `threadId`, `turnId`, `agentSessionId`.

## Waking a run with new input

While an issue is still delegated, additional prompts in the Linear agent session are forwarded into the active run (or queued until the next run wakes). This is the intended steering surface; do not take over in the worktree unless automation is clearly stuck.

## Taking a run over manually

When the agent cannot make progress and you need to drive the worktree yourself:

1. Pause delegation on the Linear issue (undelegate the PatchRelay app). This keeps the worktree in place but stops PatchRelay from writing to the branch.
2. `patchrelay issue open APP-123` — resume the Codex thread in the worktree.
3. When you are done, either push and let normal webhook loops pick up, or re-delegate to hand control back to PatchRelay.

Undelegation does not erase PR truth. Worktrees, branches, and PRs stay in place; PatchRelay just stops actively writing. Downstream services (`review-quill`, `merge-steward`) continue to work on qualifying PRs regardless of delegation state — see [architecture.md](./architecture.md#ownership) for the full ownership model.
