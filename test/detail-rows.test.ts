import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineEntry, TimelineRunInput } from "../src/cli/watch/timeline-builder.ts";
import { buildDetailLines } from "../src/cli/watch/detail-rows.ts";
import { lineToPlainText, renderRichTextLines } from "../src/cli/watch/render-rich-text.ts";
import type { WatchIssue } from "../src/cli/watch/watch-state.ts";

function makeIssue(key: string, overrides?: Partial<WatchIssue>): WatchIssue {
  return {
    issueKey: key,
    projectId: "test-project",
    factoryState: "implementing",
    blockedByCount: 0,
    blockedByKeys: [],
    readyForExecution: false,
    updatedAt: "2026-03-25T10:00:00.000Z",
    ...overrides,
  };
}

function detailText(lines: ReturnType<typeof buildDetailLines>): string[] {
  return lines.map(lineToPlainText).filter((line) => line.length > 0);
}

test("renderRichTextLines formats links, bullets, and code blocks without raw markdown wrappers", () => {
  const lines = renderRichTextLines([
    "Summary with [sessionSchema.ts](/tmp/sessionSchema.ts#L42).",
    "",
    "- first bullet",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n"), {
    key: "rich-text",
    width: 80,
  });

  const text = lines.map(lineToPlainText).join("\n");
  assert.match(text, /sessionSchema\.ts/);
  assert.doesNotMatch(text, /\/tmp\/sessionSchema\.ts#L42/);
  assert.match(text, /• first bullet/);
  assert.match(text, /const answer = 42;/);
  assert.doesNotMatch(text, /\[sessionSchema\.ts\]\(/);
  assert.doesNotMatch(text, /```/);
});

test("renderRichTextLines uses color without extra bolding for links and inline code", () => {
  const lines = renderRichTextLines("Updated [LandingPage.tsx](/tmp/LandingPage.tsx#L24) with `npm run test`.", {
    key: "rich-text-style",
    width: 80,
  });

  const styledSegments = lines.flatMap((line) => line.segments).filter((segment) => segment.color === "cyan" || segment.color === "yellow");
  const cyanText = styledSegments.filter((segment) => segment.color === "cyan").map((segment) => segment.text).join("");
  const yellowText = styledSegments.filter((segment) => segment.color === "yellow").map((segment) => segment.text).join("");

  assert.match(cyanText, /LandingPage\.tsx/);
  assert.match(yellowText, /npm run test/);
  for (const segment of styledSegments) {
    assert.equal(segment.bold, undefined);
  }
});

test("buildDetailLines keeps completed timeline runs collapsed to a summary", () => {
  const issue = makeIssue("USE-1");
  const timeline: TimelineEntry[] = [
    {
      id: "run-start-1",
      at: "2026-03-25T10:00:00.000Z",
      kind: "run-start",
      runId: 1,
      run: { runType: "implementation", status: "completed", startedAt: "2026-03-25T10:00:00.000Z", endedAt: "2026-03-25T10:05:00.000Z" },
    },
    {
      id: "item-1",
      at: "2026-03-25T10:00:10.000Z",
      kind: "item",
      runId: 1,
      item: { id: "msg-1", type: "agentMessage", status: "completed", text: "First progress update." },
    },
    {
      id: "item-2",
      at: "2026-03-25T10:00:20.000Z",
      kind: "item",
      runId: 1,
      item: { id: "msg-2", type: "agentMessage", status: "completed", text: "Final summary update." },
    },
    {
      id: "run-end-1",
      at: "2026-03-25T10:05:00.000Z",
      kind: "run-end",
      runId: 1,
      run: { runType: "implementation", status: "completed", startedAt: "2026-03-25T10:00:00.000Z", endedAt: "2026-03-25T10:05:00.000Z" },
    },
  ];

  const text = detailText(buildDetailLines({
    issue,
    timeline,
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 80,
  })).join("\n");

  assert.match(text, /Final summary update\./);
  assert.doesNotMatch(text, /First progress update\./);
});

test("buildDetailLines renders history messages with markdown-friendly formatting", () => {
  const issue = makeIssue("USE-1", { factoryState: "changes_requested" });
  const rawRuns: TimelineRunInput[] = [{
    id: 7,
    runType: "review_fix",
    status: "completed",
    startedAt: "2026-03-25T10:00:00.000Z",
    endedAt: "2026-03-25T10:05:00.000Z",
    report: {
      runType: "review_fix",
      status: "completed",
      prompt: "",
      assistantMessages: [
        "Updated [app-shell.spec.ts](/tmp/app-shell.spec.ts#L282) and verified with `npm test`.",
      ],
      plans: [],
      reasoning: [],
      commands: [],
      fileChanges: [],
      toolCalls: [],
      eventCounts: {},
    },
  }];

  const text = detailText(buildDetailLines({
    issue,
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "history",
    rawRuns,
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 90,
  })).join("\n");

  assert.match(text, /app-shell\.spec\.ts/);
  assert.doesNotMatch(text, /\/tmp\/app-shell\.spec\.ts#L282/);
  assert.match(text, /npm test/);
  assert.doesNotMatch(text, /\[app-shell\.spec\.ts\]\(/);
});

test("buildDetailLines renders header status notes with markdown-friendly formatting and compact link labels", () => {
  const issue = makeIssue("USE-9", {
    statusNote: "Updated [AppOverviewPanel.tsx](/tmp/AppOverviewPanel.tsx#L24) and verified with `npm test`.",
  });

  const text = detailText(buildDetailLines({
    issue,
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 90,
  })).join("\n");

  assert.match(text, /AppOverviewPanel\.tsx/);
  assert.doesNotMatch(text, /\/tmp\/AppOverviewPanel\.tsx#L24/);
  assert.match(text, /npm test/);
  assert.doesNotMatch(text, /\[AppOverviewPanel\.tsx\]\(/);

  const noteLine = buildDetailLines({
    issue,
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 90,
  }).find((line) => line.segments.some((segment) => segment.text.includes("Updated")));

  assert.equal(noteLine?.segments.some((segment) => segment.dimColor === true), false);
});

test("buildDetailLines prefers full check summary over gate status for re-review state", () => {
  const issue = makeIssue("TST-30", {
    factoryState: "changes_requested",
    readyForExecution: true,
    prNumber: 26,
    prReviewState: "changes_requested",
    prCheckStatus: "success",
    prChecksSummary: {
      total: 3,
      completed: 2,
      passed: 2,
      failed: 0,
      pending: 1,
      overall: "success",
    },
  });

  const text = detailText(buildDetailLines({
    issue,
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 100,
  })).join("\n");

  assert.match(text, /changes requested/);
  assert.match(text, /checks 2\/3/);
  assert.match(text, /checks 2\/3 still running/);
  assert.doesNotMatch(text, /re-review needed/);
  assert.doesNotMatch(text, /checks passed/);
  assert.doesNotMatch(text, / {2}ready {2}/);
});

test("buildDetailLines shows completion check as a first-class transient stage", () => {
  const issue = makeIssue("USE-120", {
    factoryState: "implementing",
    sessionState: "running",
    activeRunType: "implementation",
    completionCheckActive: true,
    statusNote: "No PR found; checking next step",
  });

  const text = detailText(buildDetailLines({
    issue,
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: 42,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 100,
  })).join("\n");

  assert.match(text, /completion check/);
  assert.match(text, /No PR found; checking next step/);
});

test("buildDetailLines keeps header PR and review facts colorized instead of flattening them to dim text", () => {
  const issue = makeIssue("TST-33", {
    prNumber: 27,
    prReviewState: "approved",
    prCheckStatus: "success",
  });

  const lines = buildDetailLines({
    issue,
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 100,
  });

  const headerLine = lines[0];
  assert.ok(headerLine);
  const prSegment = headerLine.segments.find((segment) => segment.text === "PR #27");
  const approvedSegment = headerLine.segments.find((segment) => segment.text === "approved");
  const checksSegment = headerLine.segments.find((segment) => segment.text === "checks passed");

  assert.equal(prSegment?.color, "cyan");
  assert.equal(approvedSegment?.color, "green");
  assert.equal(checksSegment?.color, "green");
});

test("buildDetailLines shows awaiting review and downstream queue facts without falling back to ready", () => {
  const reviewIssue = makeIssue("TST-39", {
    factoryState: "pr_open",
    readyForExecution: true,
    prNumber: 38,
    prReviewState: "review_required",
    prCheckStatus: "success",
  });
  const downstreamIssue = makeIssue("TST-43", {
    factoryState: "awaiting_queue",
    readyForExecution: true,
    prNumber: 36,
    prReviewState: "approved",
    prCheckStatus: "success",
  });

  const reviewText = detailText(buildDetailLines({
    issue: reviewIssue,
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 100,
  })).join("\n");
  const downstreamText = detailText(buildDetailLines({
    issue: downstreamIssue,
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: [],
    follow: true,
    connected: true,
    lastServerMessageAt: Date.now(),
    width: 100,
  })).join("\n");

  assert.match(reviewText, /awaiting review/);
  assert.doesNotMatch(reviewText, / {2}ready {2}/);
  assert.match(downstreamText, /merge queue/);
  assert.doesNotMatch(downstreamText, / {2}ready {2}/);
});
