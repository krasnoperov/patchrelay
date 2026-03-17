# PatchRelay Module Map

PatchRelay is easiest to maintain when the code reads like a harness with a few clear layers.
This map is intentionally practical: it points at the modules that currently carry each
responsibility so future cleanup can reduce boundary drift without forcing a large refactor.

## Policy Layer

Repository-owned workflow files and stage prompts live outside the service code. The service reads
them and passes them through, but it should not absorb repo-specific business logic that belongs in
workflow files.

Related code:

- `src/stage-launch.ts`
- `src/workflow-policy.ts`
- `docs/IMPLEMENTATION_WORKFLOW_REQUIREMENTS.md`
- `docs/REVIEW_WORKFLOW_REQUIREMENTS.md`
- `docs/DEPLOY_WORKFLOW_REQUIREMENTS.md`
- `docs/CLEANUP_WORKFLOW_REQUIREMENTS.md`

## Coordination Layer

These modules decide what work should run, what should be retried, and how startup reconciliation
turns persisted harness state back into safe next actions.

Related code:

- `src/service.ts`
- `src/service-runtime.ts`
- `src/service-stage-runner.ts`
- `src/service-stage-finalizer.ts`
- `src/service-queue.ts`
- `src/workflow-ports.ts`

## Execution Layer

These modules own the mechanics of running work inside the repo: worktrees, Codex threads and
turns, and delivery of follow-up human input into active turns.

Related code:

- `src/worktree-manager.ts`
- `src/codex-app-server.ts`
- `src/stage-turn-input-dispatcher.ts`
- `src/stage-reporting.ts`
- `src/stage-agent-activity-publisher.ts`

## Integration Layer

These modules connect the harness to external systems and keep those systems in sync with
deterministic service-owned behavior.

Related code:

- `src/service-webhooks.ts`
- `src/service-webhook-processor.ts`
- `src/webhook-comment-handler.ts`
- `src/webhook-agent-session-handler.ts`
- `src/webhook-installation-handler.ts`
- `src/linear-client.ts`
- `src/linear-oauth-service.ts`
- `src/linear-oauth.ts`
- `src/linear-workflow.ts`
- `src/stage-lifecycle-publisher.ts`
- `src/stage-failure.ts`

## Observability Layer

These modules explain what happened after or during execution. They should stay useful even when
some cache-like artifacts are missing and need to be rebuilt.

Related code:

- `src/issue-query-service.ts`
- `src/http.ts`
- `src/cli/data.ts`
- `src/cli/formatters/text.ts`
- `src/cli/formatters/json.ts`
- `src/logging.ts`
- `docs/architecture.md`
- `docs/state-authority.md`

## Persistence Boundaries

Persistence currently crosses layers, but the intended split is:

- coordination state in SQLite
- execution artifacts in worktrees and Codex threads
- integration state in Linear and OAuth/token storage
- observability artifacts in reports and optional event history

When a new feature spans multiple layers, prefer keeping the coordination decision in the harness
and pushing repo-specific behavior back out to workflow files or agent tools.
