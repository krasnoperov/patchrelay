import type { OperatorFeedEvent, DetailTab, WatchDiffSummary, WatchIssue, WatchIssueContext, WatchTokenUsage } from "./watch-state.ts";
import type { TimelineEntry, TimelineRunInput } from "./timeline-builder.ts";
import { issueTokenFor, prTokenFor } from "./issue-token.ts";
import { buildEventLogLines, formatEventAge, type EventLogLine } from "./event-log-rows.ts";
import { renderTextLines, type TextLine, type TextSegment } from "./render-rich-text.ts";

interface BuildDetailLinesInput {
  issue: WatchIssue;
  timeline: TimelineEntry[];
  activeRunStartedAt: string | null;
  activeRunId: number | null;
  tokenUsage: WatchTokenUsage | null;
  diffSummary: WatchDiffSummary | null;
  plan: Array<{ step: string; status: string }> | null;
  issueContext: WatchIssueContext | null;
  detailTab: DetailTab;
  rawRuns: TimelineRunInput[];
  rawFeedEvents: OperatorFeedEvent[];
  width: number;
}

const AGE_WIDTH = 4;
const CATEGORY_WIDTH = 7;

export function buildDetailLines(input: BuildDetailLinesInput): TextLine[] {
  const width = Math.max(20, input.width);
  const lines: TextLine[] = [];
  lines.push(...buildHeaderLines(input.issue, width));
  lines.push(blankLine("header-gap"));
  lines.push(...buildEventLines({ rawRuns: input.rawRuns, rawFeedEvents: input.rawFeedEvents }, width));
  return lines;
}

function buildHeaderLines(issue: WatchIssue, width: number): TextLine[] {
  const token = issueTokenFor(issue);
  const pr = prTokenFor(issue);
  const key = issue.issueKey ?? issue.projectId;

  const segments: TextSegment[] = [
    { text: key, color: token.color, bold: true },
    { text: "  " },
    { text: token.glyph, color: token.color },
    { text: "  " },
    { text: token.phrase },
  ];
  if (pr) {
    segments.push({ text: "   " });
    segments.push({ text: `#${pr.prNumber} ${pr.glyph}`, color: pr.color });
  }
  if (issue.title) {
    segments.push({ text: "   " });
    segments.push({ text: issue.title, dimColor: true });
  }

  const plainLines = renderTextLines(segmentsToText(segments), { key: "detail-header", width });
  if (plainLines.length > 0) {
    plainLines[0] = { key: plainLines[0]!.key, segments };
  }
  return plainLines;
}

function buildEventLines(
  source: { rawRuns: TimelineRunInput[]; rawFeedEvents: OperatorFeedEvent[] },
  width: number,
): TextLine[] {
  const events = buildEventLogLines(source);
  if (events.length === 0) return [];
  const lines: TextLine[] = [];
  for (const event of events) {
    lines.push(renderEventLine(event));
    if (event.continuation) {
      const continuation = event.continuation;
      const indent = AGE_WIDTH + 2 + CATEGORY_WIDTH + 2;
      const wrapWidth = Math.max(20, width - indent);
      const wrapped = renderTextLines(continuation, {
        key: `${event.id}-cont`,
        width: wrapWidth,
        firstPrefix: [{ text: " ".repeat(indent) }],
        continuationPrefix: [{ text: " ".repeat(indent) }],
        style: { dimColor: true },
      });
      lines.push(...wrapped);
    }
  }
  return lines;
}

function renderEventLine(event: EventLogLine): TextLine {
  const age = formatEventAge(event.at).padStart(AGE_WIDTH, " ");
  const category = event.category.padEnd(CATEGORY_WIDTH, " ");
  const segments: TextSegment[] = [
    { text: age, dimColor: true },
    { text: "  " },
    { text: category, dimColor: true },
    { text: "  " },
    { text: event.phrase, ...(event.color ? { color: event.color } : {}) },
  ];
  return { key: event.id, segments };
}

function segmentsToText(segments: TextSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

function blankLine(key: string): TextLine {
  return { key, segments: [{ text: "" }] };
}
