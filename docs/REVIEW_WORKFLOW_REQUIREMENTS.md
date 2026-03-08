# Review Workflow Requirements

Each repo-local `REVIEW_WORKFLOW.md` should tell the review agent:

1. how to read the issue from Linear and confirm it is in `Review`
2. how to claim the issue by moving it to `Reviewing`
3. how to inspect the implementation branch, diff, and verification evidence
4. what correctness, regression, and test-quality checks are required
5. when the review can approve the work and move the issue to `Deploy`
6. when the review must return the issue to `Start`
7. when the review may move directly to `Deploying` if it is taking deploy ownership immediately
8. when the review must move the issue to `Human Needed`
9. what Linear comment or structured review summary is required
