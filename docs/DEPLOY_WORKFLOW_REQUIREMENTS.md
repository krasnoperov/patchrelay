# Deploy Workflow Requirements

Each repo-local `DEPLOY_WORKFLOW.md` should tell the deploy agent:

1. how to confirm the issue is approved for deployment
2. how to verify the correct branch, artifact, or release target
3. what deployment procedure is allowed in that repository
4. what post-deploy validation is mandatory
5. what deploy evidence must be captured in the thread history
6. when successful deployment should move the issue to `Done`
7. when the issue should move to `Cleanup`
8. when deployment must stop and move the issue to `Human Needed`
