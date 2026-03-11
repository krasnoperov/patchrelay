# Cleanup Workflow Requirements

Each repo-local `CLEANUP_WORKFLOW.md` is policy consumed by a PatchRelay-managed cleanup stage run. It should define what cleanup is allowed to do, what final notes must be preserved, and when the issue can be fully closed.

Each repo-local `CLEANUP_WORKFLOW.md` should tell the cleanup agent:

1. how to confirm deployment is complete and cleanup is allowed
2. which post-release tasks are safe to perform in the issue workspace
3. whether the workspace or branch should be retained or closed
4. what final notes must be captured for auditability
5. when cleanup should mark the issue fully complete
6. when cleanup must stop and escalate to `Human Needed`
