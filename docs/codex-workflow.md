# PatchRelay Codex Workflow

For each stage run, PatchRelay sends Codex a turn that includes:

1. the Linear issue key and title
2. the Linear issue URL when available
3. the current stage name
4. the prepared worktree context
5. the full contents of the repo-local stage workflow file

Codex must:

1. work only inside the prepared worktree
2. treat the current stage workflow file as the controlling policy for that turn
3. leave enough evidence in the thread history for PatchRelay to build a read-only report
4. keep the worktree in a reviewable state for the next stage

While a turn is active, PatchRelay may steer it with fresh Linear comment context instead of waiting for the next stage.

Stage continuity is handled by PatchRelay through thread forking and workspace reuse, not by terminal session reuse.
