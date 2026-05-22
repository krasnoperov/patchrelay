import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import {
  buildFollowupIntentPrompt,
  CodexFollowupIntentClassifier,
  followupIntentShouldSteerActiveRun,
  lowConfidenceFollowupIntent,
  parseFollowupIntentClassification,
} from "../src/followup-intent.ts";
import type { CodexThreadSummary } from "../src/types.ts";

test("parseFollowupIntentClassification accepts the structured classifier shape", () => {
  assert.deepEqual(
    parseFollowupIntentClassification('{"intent":"status","confidence":0.82,"reason":"The user asks for progress."}'),
    {
      intent: "status",
      confidence: 0.82,
      reason: "The user asks for progress.",
    },
  );
});

test("parseFollowupIntentClassification extracts a JSON object from surrounding text", () => {
  assert.deepEqual(
    parseFollowupIntentClassification('classification: {"intent":"resume_or_retry","confidence":1.4,"reason":"Continue requested."} done'),
    {
      intent: "resume_or_retry",
      confidence: 1,
      reason: "Continue requested.",
    },
  );
});

test("parseFollowupIntentClassification rejects invalid intent results", () => {
  assert.equal(parseFollowupIntentClassification('{"intent":"ship_it","confidence":0.9,"reason":"No."}'), undefined);
  assert.equal(parseFollowupIntentClassification('{"intent":"status","confidence":"high","reason":"No."}'), undefined);
  assert.equal(parseFollowupIntentClassification('{"intent":"status","confidence":0.9,"reason":""}'), undefined);
});

test("low-confidence unknown classifications still steer active turns", () => {
  const classification = lowConfidenceFollowupIntent("Classifier unavailable.");
  assert.equal(classification.intent, "unknown_needs_ack");
  assert.equal(followupIntentShouldSteerActiveRun(classification), true);
});

test("low-confidence classifier control intents downgrade to unknown", async () => {
  const thread: CodexThreadSummary = {
    id: "thread-low-confidence",
    preview: "",
    cwd: "/tmp",
    status: "completed",
    turns: [{
      id: "turn-low-confidence",
      status: "completed",
      items: [{
        id: "item-low-confidence",
        type: "agentMessage",
        text: '{"intent":"stop","confidence":0.2,"reason":"Maybe asking to stop."}',
      }],
    }],
  };
  const classifier = new CodexFollowupIntentClassifier({
    startThreadForFollowupIntent: async () => thread,
    startTurn: async () => ({ threadId: thread.id, turnId: "turn-low-confidence", status: "completed" }),
    readThread: async () => thread,
  }, pino({ enabled: false }));

  const classification = await classifier.classify("hold maybe?", {
    source: "agentPrompted",
    activeRunType: "implementation",
    factoryState: "implementing",
    delegatedToPatchRelay: true,
    explicitWakeIntent: true,
  });

  assert.equal(classification.intent, "unknown_needs_ack");
  assert.equal(classification.confidence, 0.2);
  assert.match(classification.reason, /Low confidence/);
});

test("buildFollowupIntentPrompt carries state facts without encoding keyword routing", () => {
  const prompt = buildFollowupIntentPrompt("Here is the extra constraint.", {
    source: "comment",
    activeRunType: "review_fix",
    factoryState: "changes_requested",
    directReply: false,
    delegatedToPatchRelay: true,
    prReviewState: "changes_requested",
    explicitWakeIntent: true,
  });
  assert.match(prompt, /Return exactly one JSON object/);
  assert.match(prompt, /Active run type: review_fix/);
  assert.match(prompt, /Explicit PatchRelay wake context: yes/);
});
