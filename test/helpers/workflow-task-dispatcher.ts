import pino from "pino";
import type { PatchRelayDatabase } from "../../src/db.ts";
import type { CodexAppServerClient } from "../../src/codex-app-server.ts";
import type { LinearClientProvider } from "../../src/linear-types.ts";
import type { OperatorEventFeed } from "../../src/operator-feed.ts";
import { RunOrchestrator } from "../../src/run-orchestrator.ts";
import { noopTelemetry, type PatchRelayTelemetry } from "../../src/telemetry.ts";
import type { AppConfig } from "../../src/types.ts";
import { WorkflowTaskDispatcher } from "../../src/workflow-task-dispatcher.ts";

// Test wiring for `WorkflowTaskDispatcher`. Webhook-shaped tests don't release
// run leases (the orchestrator owns that), so the test dispatcher
// uses a no-op release. Tests that need the release path pass their
// own callback. Tests that assert on feed events pass their own feed.
export function createTestWorkflowTaskDispatcher(
  db: PatchRelayDatabase,
  enqueueIssue: (projectId: string, issueId: string) => void,
  releaseLease: (projectId: string, issueId: string) => void = () => undefined,
  feed?: OperatorEventFeed,
): WorkflowTaskDispatcher {
  return new WorkflowTaskDispatcher(
    db,
    enqueueIssue,
    releaseLease,
    pino({ enabled: false }),
    feed,
  );
}

export function createTestRunOrchestrator(
  config: AppConfig,
  db: PatchRelayDatabase,
  codex: CodexAppServerClient,
  linearProvider: LinearClientProvider,
  enqueueIssue: (projectId: string, issueId: string) => void,
  logger: pino.Logger,
  feed?: OperatorEventFeed,
  configPath?: string,
  telemetry: PatchRelayTelemetry = noopTelemetry,
): RunOrchestrator {
  let orchestrator: RunOrchestrator;
  const dispatcher = new WorkflowTaskDispatcher(
    db,
    enqueueIssue,
    (projectId, linearIssueId) => orchestrator.leaseService.release(projectId, linearIssueId),
    logger,
    feed,
    telemetry,
  );
  orchestrator = new RunOrchestrator(
    config,
    db,
    codex,
    linearProvider,
    enqueueIssue,
    dispatcher,
    logger,
    feed,
    configPath,
    telemetry,
  );
  return orchestrator;
}
