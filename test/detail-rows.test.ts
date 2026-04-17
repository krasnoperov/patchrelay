import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineRunInput } from "../src/cli/watch/timeline-builder.ts";
import { buildDetailLines } from "../src/cli/watch/detail-rows.ts";
import { lineToPlainText, renderRichTextLines } from "../src/cli/watch/render-rich-text.ts";
import type { OperatorFeedEvent } from "../src/operator-feed.ts";
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

test("detail header renders issue token, phrase, PR token, and title", () => {
  const lines = buildDetailLines({
    issue: makeIssue("EQ-42", {
      title: "Fix the race in loadUser",
      factoryState: "implementing",
      prNumber: 1135,
      prState: "open",
      prChecksSummary: {
        total: 3,
        completed: 3,
        passed: 3,
        failed: 0,
        pending: 0,
        overall: "success",
      },
    }),
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
    width: 100,
  });

  const text = detailText(lines)[0]!;
  assert.match(text, /EQ-42/);
  assert.match(text, /●/);
  assert.match(text, /implementing/);
  assert.match(text, /#1135/);
  assert.match(text, /✓/);
  assert.match(text, /Fix the race in loadUser/);
});

test("detail event log orders runs and feed events chronologically with category tokens", () => {
  const runs: TimelineRunInput[] = [
    {
      id: 1,
      runType: "implementation",
      status: "completed",
      startedAt: "2026-03-25T09:00:00.000Z",
      endedAt: "2026-03-25T09:15:00.000Z",
    },
  ];
  const feedEvents: OperatorFeedEvent[] = [
    {
      id: 1,
      at: "2026-03-25T09:10:00.000Z",
      level: "info",
      kind: "stage",
      summary: "stage transition",
      stage: "delegated",
      nextStage: "implementing",
    },
    {
      id: 2,
      at: "2026-03-25T09:20:00.000Z",
      level: "info",
      kind: "github",
      summary: "PR #1135 opened",
    },
  ];

  const lines = buildDetailLines({
    issue: makeIssue("EQ-42"),
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: runs,
    rawFeedEvents: feedEvents,
    width: 100,
  });

  const texts = detailText(lines);
  const eventTexts = texts.slice(1);
  assert.equal(eventTexts.length, 4, `expected 4 events, got ${eventTexts.length}: ${eventTexts.join("\n")}`);
  assert.match(eventTexts[0]!, /run\s+implementation started/);
  assert.match(eventTexts[1]!, /stage\s+delegated → implementing/);
  assert.match(eventTexts[2]!, /run\s+implementation ended · success/);
  assert.match(eventTexts[3]!, /github\s+PR #1135 opened/);
});

test("detail event log drops internal webhook/service/hook kinds", () => {
  const feedEvents: OperatorFeedEvent[] = [
    {
      id: 1,
      at: "2026-03-25T09:00:00.000Z",
      level: "info",
      kind: "webhook",
      summary: "webhook received",
    },
    {
      id: 2,
      at: "2026-03-25T09:05:00.000Z",
      level: "info",
      kind: "service",
      summary: "service started",
    },
    {
      id: 3,
      at: "2026-03-25T09:10:00.000Z",
      level: "info",
      kind: "github",
      summary: "PR merged",
    },
  ];

  const lines = buildDetailLines({
    issue: makeIssue("EQ-42"),
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: [],
    rawFeedEvents: feedEvents,
    width: 100,
  });

  const texts = detailText(lines).slice(1).join("\n");
  assert.doesNotMatch(texts, /webhook received/);
  assert.doesNotMatch(texts, /service started/);
  assert.match(texts, /PR merged/);
});

test("failed run gets a red phrase and a continuation line with the reason", () => {
  const runs: TimelineRunInput[] = [
    {
      id: 7,
      runType: "ci_repair",
      status: "failed",
      startedAt: "2026-03-25T09:00:00.000Z",
      endedAt: "2026-03-25T09:05:00.000Z",
      report: { failureReason: "tsc exit 2: type error in loadUser.ts" } as unknown as TimelineRunInput["report"],
    },
  ];
  const lines = buildDetailLines({
    issue: makeIssue("EQ-42"),
    timeline: [],
    activeRunStartedAt: null,
    activeRunId: null,
    tokenUsage: null,
    diffSummary: null,
    plan: null,
    issueContext: null,
    detailTab: "timeline",
    rawRuns: runs,
    rawFeedEvents: [],
    width: 100,
  });

  const endLine = lines.find((line) => lineToPlainText(line).includes("ci repair ended"));
  assert.ok(endLine, "expected 'ci repair ended' line");
  const phraseSegment = endLine!.segments.find((segment) => segment.color === "red");
  assert.ok(phraseSegment, "expected red phrase segment for failed run");
  const text = detailText(lines).join("\n");
  assert.match(text, /tsc exit 2: type error/);
});
