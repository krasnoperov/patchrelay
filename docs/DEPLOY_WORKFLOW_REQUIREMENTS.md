# Deploy Workflow Requirements

Each repo-local `DEPLOY_WORKFLOW.md` should tell the deploy agent:

1. how to read the issue from Linear and confirm it is in `Deploy`
2. how to claim the issue by moving it to `Deploying`
3. how to verify the branch, artifact, or PR to deploy
4. what deployment command or release procedure is allowed for that repo
5. what post-deploy verification is required
6. when successful deployment should move the issue to `Done`
7. when a deployment problem should move the issue to `Human Needed`
8. what deployment notes, links, or evidence should be written back to Linear
