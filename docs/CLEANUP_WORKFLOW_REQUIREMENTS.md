# Cleanup Workflow Requirements

Each repo-local `CLEANUP_WORKFLOW.md` should tell the cleanup agent:

1. how to confirm deployment is complete and cleanup is allowed
2. which post-release tasks are safe to perform in the issue workspace
3. whether the workspace or branch should be retained or closed
4. what final notes must be captured for auditability
5. when cleanup should mark the issue fully complete
6. when cleanup must stop and escalate to `Human Needed`
