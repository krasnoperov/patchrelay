import pino from "pino";
import type { PatchRelayDatabase } from "../../src/db.ts";
import type { OperatorEventFeed } from "../../src/operator-feed.ts";
import { WakeDispatcher } from "../../src/wake-dispatcher.ts";

// Test wiring for `WakeDispatcher`. Webhook-shaped tests don't release
// run leases (the orchestrator owns that), so the test dispatcher
// uses a no-op release. Tests that need the release path pass their
// own callback. Tests that assert on feed events pass their own feed.
export function createTestWakeDispatcher(
  db: PatchRelayDatabase,
  enqueueIssue: (projectId: string, issueId: string) => void,
  releaseLease: (projectId: string, issueId: string) => void = () => undefined,
  feed?: OperatorEventFeed,
): WakeDispatcher {
  return new WakeDispatcher(
    db,
    enqueueIssue,
    releaseLease,
    pino({ enabled: false }),
    feed,
  );
}
