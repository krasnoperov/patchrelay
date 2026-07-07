# PatchRelay Operator Guide

Day-to-day usage, command cheatsheet, and troubleshooting paths once PatchRelay is installed and linked to a repo.

For install and first-time setup, see [self-hosting.md](./self-hosting.md). For architecture, see [architecture.md](./architecture.md).

## Daily loop

1. Delegate a Linear issue to the PatchRelay app.
2. Linear sends delegation and agent-session webhooks to PatchRelay, which creates or reuses the issue worktree and launches an implementation run.
3. Follow up in the Linear agent session to steer the active run or queue fresh workflow input while it remains delegated.
4. GitHub webhooks automatically trigger CI repair, review fix, or merge queue repair runs when needed.
5. Watch progress from the terminal, or open the same worktree and take over manually.

### Sequencing predictable conflicts at planning time

When two issues will both touch the same lock file, the same schema migration,
the same shared enum, or the same normalization helper, they will conflict at
integration time. The merge-steward eviction loop catches it, but every cycle
costs a fresh review and a queue restart.

For predictable conflicts, set `B blockedBy A` in Linear **before either
starts**. PatchRelay already honors `blockedBy` (the `IssueRecord.blockedByCount`
field gates start). When A reaches Done, B starts on a main that already
contains A's changes, so there is no conflict to resolve.

This is Tier 1 of the three-tier sequencing model — see [concepts.md](./concepts.md#sequencing--three-tiers-for-predictable-conflicts) for the full picture.

Heuristics for when to set `blockedBy` at planning:

- both issues touch a lock file (`package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `Cargo.lock`, …)
- both issues edit the same migration sequence or schema file
- both issues rename, replace, or remove a shared helper / enum / type
- both issues edit the same normalization or compatibility shim
- one issue establishes a new convention the other must follow

The cost is latency — B waits for A. The cost is worth paying when the
conflict is genuinely predictable. If the conflict is only visible at
handoff (after the diff is in hand), the runtime `sequence-check` path
(see plan §8.2) covers it without `blockedBy`.

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

### Operator alert vocabulary

Cluster-health (`patchrelay cluster-health`) and the queue-health monitor surface stuck-state alerts using the Linear-state-prefixed convention from [concepts.md](./concepts.md#four-states). The prefix matches what the team already reads in Linear; the suffix is the diagnostic.

| Display | Where it fires | Trigger |
|-|-|-|
| In Review · stuck at admission | `patchrelay cluster-health` and the queue-health monitor (`IN_REVIEW_STUCK` event) | PR is approved but a required check is red, no `ci_repair` is running, and the issue has been in this state ≥ 30 min |

Other "PR is in this Linear state — but why isn't progression happening right now?" conditions are surfaced today on the merge-steward dashboard rather than as cluster-health alerts:

- **In Deploy · retry-gated** — integration conflict; the steward is waiting for `main` to advance before retrying. See `merge-steward queue show --pr <num>`.
- **In Deploy · queue paused (operator hold)** — explicit pause on the project, queue, or single PR.
- **In Deploy · dequeued** — operator pulled the issue from the queue mid-flight.

The cluster-health entry above is the one alert that today is also raised through the IN_REVIEW_STUCK feed event so it shows up in the operator activity stream, not only on a dashboard view.

### Common log patterns

| Symptom | Look for |
|-|-|
| Linear did nothing after a delegation or mention | Webhook intake lines — accepted, rejected, stale, or duplicate deliveries |
| Agent ignored a new Linear comment or prompt | Whether the issue comment explicitly started with `PatchRelay` or `@PatchRelay`, `prompt_delivered` session events, queued turn-input delivery lines, and any delivery failure warnings |
| Codex execution looks broken or stops unexpectedly | `Starting Codex app-server`, `Codex app-server request failed`, `Codex app-server stderr`, `Codex app-server exited` |
| Requested-changes repair stopped without returning to review | `Requested-changes run finished ... without pushing a new head past blocking review SHA` |
| Queue repair started after an integration failure | `PR needs queue repair from fresh GitHub truth`, `Started queue_repair run`, and the `merge-steward/queue` check run |
| Old closed PRs keep appearing in logs | `Reconciliation: PR was closed on a terminal issue; preserving terminal state` |
| Startup/recovery cannot read an empty Codex thread yet | `thread ... is not materialized yet; includeTurns is unavailable before first user message` |

The most useful correlation fields across logs: `webhookId`, `webhookEventId`, `projectId`, `issueKey`, `runType`, `threadId`, `turnId`, `agentSessionId`.

### Requested-changes head guard

After a `REQUEST_CHANGES` review, PatchRelay records the reviewed head SHA. A `review_fix` run must publish a different remote PR head before the issue can return to review. If the agent finishes without doing that, PatchRelay fails the run with a message like:

```text
Requested-changes run finished for PR #355 without pushing a new head past blocking review SHA 7586be6a;
PatchRelay must not hand the same SHA back to review.
```

Treat this as a protected stop, not as a reviewer problem. The next action is to inspect the issue worktree and the run summary:

```bash
patchrelay issue show APP-123
patchrelay issue open APP-123
git status --short
git log --oneline --decorate -5
```

If there is a real fix in the worktree, commit and push it or requeue the issue. If there is no diff, the agent did not produce a repair; clarify the requested change in Linear or take over manually.

### Queue repair handoff

When merge-steward cannot land an approved PR, it emits the configured eviction check run (default `merge-steward/queue`). PatchRelay treats that as `queue_repair`, not ordinary branch CI. The normal successful shape is:

```text
merge-steward/queue fails
PatchRelay starts queue_repair
PatchRelay pushes a fresh branch head
review-quill approves
merge-steward re-admits and merges
```

Start with the incident and the issue view:

```bash
merge-steward queue show --pr <num>
patchrelay issue show APP-123
patchrelay service logs --lines 100
```

Escalate when the incident is product ambiguity, a broken required check on `main`, missing credentials, or repeated semantic failures after fresh heads.

### Benign reconciliation noise

`Reconciliation: PR was closed on a terminal issue; preserving terminal state` means PatchRelay saw a closed PR for an issue already marked terminal and intentionally left the terminal issue state alone. A few old failed or escalated issues can produce this repeatedly during background reconciliation. It is noisy, but it is not a launch or repair request by itself.

`thread ... is not materialized yet; includeTurns is unavailable before first user message` means the app-server was asked to read a thread before the first user turn was durable. PatchRelay recovery usually retries or starts fresh. Investigate only when the same issue stays active without progress after the retry backoff.

## Queueing a run with new input

While an issue is still delegated, additional prompts in the Linear agent session are treated like chat with the agent. They are forwarded into the active run or queued as input for the next runnable workflow task. Active-run steering is checkpoint-aware: PatchRelay does not kill arbitrary in-flight shell commands, but it tells the agent to fold the new instruction into the next decision before the next meaningful side effect when possible.

Linear issue comments are not chat by default. They become agent input only when they explicitly address PatchRelay at the start, for example:

```text
PatchRelay, use the existing billing helper instead.
@PatchRelay please continue with option B.
```

Plain issue discussion, even on an awaiting-input issue, is ignored by PatchRelay unless it is addressed that way. This keeps teammate discussion from accidentally steering the agent.

PatchRelay classifies accepted follow-up text with a structured intent classifier, not a magic phrase list. Status questions during active work get a lightweight ephemeral thought; real instructions are delivered or queued. Delivery attempts are recorded as `prompt_delivered` session events. If delivery fails, the operator feed and Linear session activity call that out instead of silently losing the prompt, and final run summaries report delivered or failed steering attempts.

When a PR is already completed and someone asks for more work, use the agent session or an addressed issue comment. PatchRelay keeps the old PR facts as context, clears the current PR fields, and starts replacement implementation work that should publish a fresh PR.

Requested-changes repairs fetch review feedback from GitHub directly on every repair run. If a reviewer says "fix the PR comments" in Linear, PatchRelay still reads the review body, inline comments, reviewer, reviewed head, and current PR head from GitHub before launching the repair. If that refresh is degraded, the worker prompt says so explicitly and instructs the worker to re-read the GitHub review before changing code.

## Taking a run over manually

When the agent cannot make progress and you need to drive the worktree yourself:

1. Pause delegation on the Linear issue (undelegate the PatchRelay app). This keeps the worktree in place but stops PatchRelay from writing to the branch.
2. `patchrelay issue open APP-123` — resume the Codex thread in the worktree.
3. When you are done, either push and let normal webhook loops pick up, or re-delegate to hand control back to PatchRelay.

Undelegation does not erase PR truth. Worktrees, branches, and PRs stay in place; PatchRelay just stops actively writing. Downstream services (`review-quill`, `merge-steward`) continue to work on qualifying PRs regardless of delegation state — see [architecture.md](./architecture.md#ownership) for the full ownership model.
