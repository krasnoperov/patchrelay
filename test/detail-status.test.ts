import assert from "node:assert/strict";
import test from "node:test";
import { buildDetailStatusSegments } from "../src/cli/watch/detail-status.ts";
import { lineToPlainText } from "../src/cli/watch/render-rich-text.ts";

function statusText(input: Parameters<typeof buildDetailStatusSegments>[0], now: number): string {
  return lineToPlainText({ key: "status", segments: buildDetailStatusSegments(input, now) });
}

test("buildDetailStatusSegments reports anchored review and unread rows outside the transcript body", () => {
  const text = statusText({
    follow: false,
    unreadBelow: 4,
    activeRunStartedAt: "2026-03-25T10:10:00.000Z",
    connected: true,
    lastServerMessageAt: Date.parse("2026-03-25T10:11:50.000Z"),
  }, Date.parse("2026-03-25T10:12:00.000Z"));

  assert.match(text, /anchored review/);
  assert.match(text, /4 new below/);
  assert.match(text, /run 2m 00s/);
  assert.match(text, /fresh 10s/);
});

test("buildDetailStatusSegments reports live edge and disconnected freshness", () => {
  const text = statusText({
    follow: true,
    unreadBelow: 0,
    activeRunStartedAt: null,
    connected: false,
    lastServerMessageAt: Date.parse("2026-03-25T10:11:15.000Z"),
  }, Date.parse("2026-03-25T10:12:00.000Z"));

  assert.match(text, /live edge/);
  assert.match(text, /disconnected · stale 45s/);
});
