import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveFactoryStateFromPrFacts,
  type CurrentIssueFacts,
  type ObservedPrFacts,
} from "../src/pr-facts-derivation.ts";

function current(overrides: Partial<CurrentIssueFacts> = {}): CurrentIssueFacts {
  return { factoryState: "pr_open", ...overrides };
}

test("shared derivation: identical observed facts produce the same state from both ingestion sources", () => {
  const levelFacts: Omit<ObservedPrFacts, "source"> = {
    prState: "open",
    reviewDecision: "APPROVED",
    gateCheckStatus: "success",
    headSha: "sha-1",
  };
  for (const factoryState of ["pr_open", "changes_requested", "escalated", "failed"] as const) {
    const fromPoll = deriveFactoryStateFromPrFacts({ source: "poll", ...levelFacts }, current({ factoryState }));
    const fromWebhookBuiltFacts = deriveFactoryStateFromPrFacts({ source: "webhook", ...levelFacts }, current({ factoryState }));
    assert.equal(fromPoll, fromWebhookBuiltFacts, `divergent derivation for factoryState=${factoryState}`);
  }
});

test("shared derivation parity: review approval as a webhook delta and as a polled level converge", () => {
  // Webhook path: the approval arrives as a trigger event.
  const fromWebhook = deriveFactoryStateFromPrFacts(
    { source: "webhook", triggerEvent: "review_approved", prState: "open", prNumber: 7 },
    current(),
  );
  // Reconciler path: the same truth observed later as a polled snapshot.
  const fromPoll = deriveFactoryStateFromPrFacts(
    { source: "poll", prState: "open", prNumber: 7, reviewDecision: "APPROVED", gateCheckStatus: "success" },
    current(),
  );
  assert.equal(fromWebhook, "awaiting_queue");
  assert.equal(fromPoll, "awaiting_queue");
});

test("shared derivation parity: merged PR converges to done from both paths, suppressed while a run is active", () => {
  const webhookIdle = deriveFactoryStateFromPrFacts(
    { source: "webhook", triggerEvent: "pr_merged", prState: "merged" },
    current({ factoryState: "awaiting_queue" }),
  );
  const pollIdle = deriveFactoryStateFromPrFacts(
    { source: "poll", prState: "merged" },
    current({ factoryState: "awaiting_queue" }),
  );
  assert.equal(webhookIdle, "done");
  assert.equal(pollIdle, "done");

  const webhookActive = deriveFactoryStateFromPrFacts(
    { source: "webhook", triggerEvent: "pr_merged", prState: "merged" },
    current({ factoryState: "implementing", activeRunId: 12 }),
  );
  const pollActive = deriveFactoryStateFromPrFacts(
    { source: "poll", prState: "merged" },
    current({ factoryState: "implementing", activeRunId: 12 }),
  );
  assert.equal(webhookActive, undefined);
  assert.equal(pollActive, undefined);
});

test("polled terminal recovery reopens escalated/failed issues only on newer green truth", () => {
  const cases: Array<{ observed: Omit<ObservedPrFacts, "source">; expected: string | undefined; label: string }> = [
    {
      label: "approved with green gate returns to the queue",
      observed: { prState: "open", reviewDecision: "APPROVED", gateCheckStatus: "success" },
      expected: "awaiting_queue",
    },
    {
      label: "pending gate means a re-run is in flight",
      observed: { prState: "open", reviewDecision: "CHANGES_REQUESTED", gateCheckStatus: "pending" },
      expected: "pr_open",
    },
    {
      label: "advanced head with non-failing gate reopens the PR",
      observed: { prState: "open", headAdvanced: true, gateCheckStatus: "success" },
      expected: "pr_open",
    },
    {
      label: "review required with green gate reopens the PR",
      observed: { prState: "open", reviewDecision: "REVIEW_REQUIRED", gateCheckStatus: "success" },
      expected: "pr_open",
    },
    {
      label: "approved with a red gate stays terminal (no fall-through to the approved rule)",
      observed: { prState: "open", reviewDecision: "APPROVED", gateCheckStatus: "failure" },
      expected: undefined,
    },
    {
      label: "red gate on the same head stays terminal",
      observed: { prState: "open", reviewDecision: "CHANGES_REQUESTED", gateCheckStatus: "failure" },
      expected: undefined,
    },
  ];
  for (const factoryState of ["escalated", "failed"] as const) {
    for (const entry of cases) {
      assert.equal(
        deriveFactoryStateFromPrFacts({ source: "poll", ...entry.observed }, current({ factoryState })),
        entry.expected,
        `${factoryState}: ${entry.label}`,
      );
    }
  }
});

test("polled closed-PR dispositions map to done / preserved terminal / delegated", () => {
  assert.equal(
    deriveFactoryStateFromPrFacts(
      { source: "poll", prState: "closed", closedPrDisposition: "done" },
      current({ factoryState: "done" }),
    ),
    "done",
  );
  assert.equal(
    deriveFactoryStateFromPrFacts(
      { source: "poll", prState: "closed", closedPrDisposition: "terminal" },
      current({ factoryState: "escalated" }),
    ),
    undefined,
  );
  assert.equal(
    deriveFactoryStateFromPrFacts(
      { source: "poll", prState: "closed", closedPrDisposition: "redelegate" },
      current({ factoryState: "pr_open" }),
    ),
    "delegated",
  );
});

test("webhook deltas lift awaiting_input/delegated issues with an open PR back to pr_open", () => {
  assert.equal(
    deriveFactoryStateFromPrFacts(
      { source: "webhook", triggerEvent: "check_pending", prState: "open", prNumber: 4 },
      current({ factoryState: "awaiting_input" }),
    ),
    "pr_open",
  );
  // pr_closed stays owned by the terminal handler.
  assert.equal(
    deriveFactoryStateFromPrFacts(
      { source: "webhook", triggerEvent: "pr_closed", prState: "closed" },
      current(),
    ),
    undefined,
  );
});

test("polled level observation without decisive facts is a no-op", () => {
  assert.equal(
    deriveFactoryStateFromPrFacts(
      { source: "poll", prState: "open", reviewDecision: "REVIEW_REQUIRED", gateCheckStatus: "success" },
      current(),
    ),
    undefined,
  );
});
