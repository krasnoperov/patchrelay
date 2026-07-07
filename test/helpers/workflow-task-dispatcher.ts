import pino from "pino";
import type { PatchRelayDatabase } from "../../src/db.ts";
import type { OperatorEventFeed } from "../../src/operator-feed.ts";
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
