import assert from "node:assert/strict";
import test from "node:test";
import { classifyCodexFailure } from "../src/codex-capacity.ts";

// The real production string from the LSR-837 incident.
const USAGE_LIMIT_MESSAGE =
  "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at 3:23 AM.";

test("classifies the real usage-limit message and parses the retry time for later today", () => {
  const now = new Date(2026, 5, 10, 1, 0, 0);
  const result = classifyCodexFailure(USAGE_LIMIT_MESSAGE, now);
  assert.ok(result.kind === "capacity");
  assert.equal(result.detail, USAGE_LIMIT_MESSAGE);
  assert.equal(result.retryAtIso, new Date(2026, 5, 10, 3, 23, 0).toISOString());
});

test("rolls the retry time to tomorrow when it already passed today", () => {
  const now = new Date(2026, 5, 10, 5, 0, 0);
  const result = classifyCodexFailure(USAGE_LIMIT_MESSAGE, now);
  assert.ok(result.kind === "capacity");
  assert.equal(result.retryAtIso, new Date(2026, 5, 11, 3, 23, 0).toISOString());
});

test("parses PM retry times", () => {
  const now = new Date(2026, 5, 10, 9, 0, 0);
  const result = classifyCodexFailure("Rate limit reached. Please try again at 1:05 PM.", now);
  assert.ok(result.kind === "capacity");
  assert.equal(result.retryAtIso, new Date(2026, 5, 10, 13, 5, 0).toISOString());
});

test("parses 12 AM as midnight with next-day rollover", () => {
  const now = new Date(2026, 5, 10, 23, 0, 0);
  const result = classifyCodexFailure("You've hit your usage limit. Try again at 12:30 AM.", now);
  assert.ok(result.kind === "capacity");
  assert.equal(result.retryAtIso, new Date(2026, 5, 11, 0, 30, 0).toISOString());
});

test("parses 12 PM as noon", () => {
  const now = new Date(2026, 5, 10, 9, 0, 0);
  const result = classifyCodexFailure("You've hit your usage limit. Try again at 12:15 PM.", now);
  assert.ok(result.kind === "capacity");
  assert.equal(result.retryAtIso, new Date(2026, 5, 10, 12, 15, 0).toISOString());
});

test("classifies rate-limit and quota messages without a parseable retry time", () => {
  const messages = [
    "Rate limit exceeded",
    "You exceeded your current quota, please check your plan and billing details",
    "You've hit your usage limit. Try again at sometime later.",
  ];
  for (const message of messages) {
    const result = classifyCodexFailure(message);
    assert.ok(result.kind === "capacity", `expected capacity for: ${message}`);
    assert.equal(result.retryAtIso, undefined);
    assert.equal(result.detail, message);
  }
});

test("classifies the model-at-capacity outage as capacity (transient, no retry time)", () => {
  // The real production string that terminally failed INV-35 before this fix.
  const message = "Selected model is at capacity. Please try a different model.";
  const result = classifyCodexFailure(message);
  assert.ok(result.kind === "capacity", "model-at-capacity must back off and retry, not fail");
  assert.equal(result.retryAtIso, undefined);
  assert.equal(result.detail, message);
});

test("classification is case-insensitive", () => {
  assert.equal(classifyCodexFailure("USAGE LIMIT reached for this account").kind, "capacity");
  assert.equal(classifyCodexFailure("Request was RATE LIMITED").kind, "capacity");
});

test("unrelated errors, interrupt artifacts, and missing messages classify as other", () => {
  assert.equal(classifyCodexFailure("TypeError: cannot read properties of undefined").kind, "other");
  assert.equal(classifyCodexFailure("Codex turn was interrupted").kind, "other");
  assert.equal(classifyCodexFailure(undefined).kind, "other");
  assert.equal(classifyCodexFailure("").kind, "other");
  assert.equal(classifyCodexFailure("   ").kind, "other");
});
