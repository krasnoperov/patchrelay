import { Box, Text, useStdout } from "ink";
import { RepoRow } from "./ListView.tsx";
import { clipSummary, type DashboardModel, type DashboardPrEntry, type DashboardRepo } from "./dashboard-model.ts";
import { formatTokenAge } from "./format.ts";

interface DetailViewProps {
  model: DashboardModel;
  selectedRepoFullName: string | null;
  bodyRows: number;
  topMarginRows?: number | undefined;
  scrollOffset: number;
}

const PR_ID_WIDTH = 7;
const PR_PHRASE_WIDTH = 20;
const SUMMARY_INDENT = 9;
const AGE_WIDTH = 4;

type ContentLine =
  | { kind: "blank" }
  | { kind: "entry-header"; entry: DashboardPrEntry }
  | { kind: "summary-line"; text: string };

function truncate(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return value.slice(0, maxWidth);
  return `${value.slice(0, Math.max(0, maxWidth - 1))}\u2026`;
}

export function buildContentLines(repo: DashboardRepo, width: number): ContentLine[] {
  const lines: ContentLine[] = [];
  repo.entries.forEach((entry, index) => {
    if (index > 0) lines.push({ kind: "blank" });
    lines.push({ kind: "entry-header", entry });
    if (entry.summary) {
      const summaryText = clipSummary(entry.summary, {
        maxLines: 3,
        width: Math.max(20, width - SUMMARY_INDENT),
      });
      if (summaryText) {
        summaryText.split("\n").forEach((line) => lines.push({ kind: "summary-line", text: line }));
      }
    }
  });
  return lines;
}

function EntryHeaderRow({ entry, width }: { entry: DashboardPrEntry; width: number }): React.JSX.Element {
  const idText = `#${entry.prNumber}`.padEnd(PR_ID_WIDTH, " ");
  const paddedPhrase = entry.phrase.padEnd(PR_PHRASE_WIDTH, " ");
  const age = formatTokenAge(entry.eventAt);
  const titleSpace = Math.max(0, width - (PR_ID_WIDTH + 3 + PR_PHRASE_WIDTH + 3 + AGE_WIDTH));
  const title = entry.title && entry.title !== entry.phrase && titleSpace >= 8
    ? truncate(entry.title, titleSpace)
    : "";
  return (
    <Box>
      <Text color={entry.color}>{idText}</Text>
      <Text color={entry.color}>{entry.glyph}</Text>
      <Text>{`  ${paddedPhrase}`}</Text>
      <Text dimColor>{`  ${age}`}</Text>
      {title ? <Text dimColor>{`  ${title}`}</Text> : null}
    </Box>
  );
}

function renderLine(line: ContentLine, key: number, width: number): React.JSX.Element {
  if (line.kind === "blank") return <Box key={key}><Text> </Text></Box>;
  if (line.kind === "summary-line") {
    return (
      <Box key={key}>
        <Text>{" ".repeat(SUMMARY_INDENT)}</Text>
        <Text dimColor>{line.text}</Text>
      </Box>
    );
  }
  return <EntryHeaderRow key={key} entry={line.entry} width={width} />;
}

export function clampScrollOffset(requested: number, totalLines: number, scrollArea: number): number {
  if (scrollArea <= 0 || totalLines <= scrollArea) return 0;
  // When scrolled at all, a one-row top indicator eats into the viewport, so the
  // largest useful offset lets (scrollArea - 1) rows of content fill the remainder.
  const maxOffset = Math.max(0, totalLines - Math.max(1, scrollArea - 1));
  return Math.max(0, Math.min(requested, maxOffset));
}

export function DetailView({
  model,
  selectedRepoFullName,
  bodyRows,
  topMarginRows = 1,
  scrollOffset,
}: DetailViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const width = Math.max(40, stdout?.columns ?? 80);

  const repo: DashboardRepo | null = selectedRepoFullName
    ? model.repos.find((candidate) => candidate.repoFullName === selectedRepoFullName) ?? model.repos[0] ?? null
    : model.repos[0] ?? null;

  if (!repo) {
    return <Box marginTop={topMarginRows}><Text dimColor> </Text></Box>;
  }

  const repoHeaderRows = 1;
  const separatorRows = bodyRows >= 3 ? 1 : 0;
  const scrollArea = Math.max(0, bodyRows - repoHeaderRows - separatorRows);

  const contentWidth = Math.max(20, width - 2);
  const contentLines = buildContentLines(repo, contentWidth);
  const offset = clampScrollOffset(scrollOffset, contentLines.length, scrollArea);

  const children: React.JSX.Element[] = [];
  let budget = scrollArea;

  const couldHaveAbove = offset > 0;
  const reserveTop = couldHaveAbove && budget > 0 ? 1 : 0;
  let remaining = budget - reserveTop;
  let tentativeEnd = Math.min(contentLines.length, offset + remaining);
  const belowCount = contentLines.length - tentativeEnd;
  const reserveBottom = belowCount > 0 && remaining > 0 ? 1 : 0;
  if (reserveBottom) {
    remaining = Math.max(0, remaining - 1);
    tentativeEnd = Math.min(contentLines.length, offset + remaining);
  }

  if (reserveTop) {
    children.push(
      <Box key="above"><Text dimColor>{`  \u2191${offset} more above`}</Text></Box>,
    );
  }
  for (let i = offset; i < tentativeEnd; i += 1) {
    children.push(renderLine(contentLines[i]!, i, contentWidth));
  }
  if (reserveBottom) {
    const shown = tentativeEnd;
    const hidden = contentLines.length - shown;
    children.push(
      <Box key="below"><Text dimColor>{`  \u2193${hidden} more below`}</Text></Box>,
    );
  }

  return (
    <Box flexDirection="column" marginTop={topMarginRows}>
      <RepoRow repo={repo} selected={false} showCursor={false} width={width - 2} />
      {separatorRows > 0 ? <Box><Text> </Text></Box> : null}
      {children}
    </Box>
  );
}
