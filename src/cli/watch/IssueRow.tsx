import { Box, Text } from "ink";
import type { WatchIssue } from "./watch-state.ts";
import { issueTokenFor, prTokenFor } from "./issue-token.ts";
import { formatIssueAge, truncate } from "./format-utils.ts";

interface IssueRowProps {
  issue: WatchIssue;
  selected: boolean;
  titleWidth?: number | undefined;
  compact?: boolean | undefined;
}

const KEY_WIDTH = 8;
const GLYPH_WIDTH = 3;
const PHRASE_WIDTH = 18;
const AGE_WIDTH = 4;
const WIDE_PR_PHRASE_THRESHOLD = 34;

function shouldShowVerbosePrToken(titleWidth: number | undefined, compact: boolean): boolean {
  return !compact && (titleWidth ?? 60) >= WIDE_PR_PHRASE_THRESHOLD;
}

export function IssueRow({
  issue,
  selected,
  titleWidth,
  compact = false,
}: IssueRowProps): React.JSX.Element {
  const key = issue.issueKey ?? issue.projectId;
  const token = issueTokenFor(issue);
  const pr = prTokenFor(issue);

  const cursorChar = selected ? "\u25b8" : " ";
  const paddedKey = key.padEnd(KEY_WIDTH, " ");
  const paddedPhrase = token.phrase.padEnd(PHRASE_WIDTH, " ");
  const age = formatIssueAge(issue.updatedAt);
  const verbosePr = pr && shouldShowVerbosePrToken(titleWidth, compact);
  const prWidth = pr
    ? verbosePr
      ? `#${pr.prNumber} ${pr.glyph} ${pr.phrase}`.length
      : `#${pr.prNumber} ${pr.glyph}`.length
    : 0;
  const availableTitleWidth = Math.max(0, (titleWidth ?? 60) - prWidth - (pr ? 2 : 0) - (AGE_WIDTH + 2));
  const title = !compact && selected && issue.title
    ? `  ${truncate(issue.title, Math.max(0, availableTitleWidth))}`
    : "";

  return (
    <Box>
      <Text color={selected ? "cyan" : "gray"}>{cursorChar}</Text>
      <Text bold={selected} color={token.color}>{` ${paddedKey}`}</Text>
      <Text color={token.color}>{` ${token.glyph.padEnd(GLYPH_WIDTH - 1, " ")}`}</Text>
      <Text>{` ${paddedPhrase}`}</Text>
      {pr ? (
        <>
          <Text color={pr.color}>{verbosePr ? `#${pr.prNumber} ${pr.glyph} ${pr.phrase}` : `#${pr.prNumber} ${pr.glyph}`}</Text>
        </>
      ) : null}
      <Text dimColor>{`  ${age}`}</Text>
      {title ? <Text dimColor>{title}</Text> : null}
    </Box>
  );
}

export function estimateIssueRowHeight(
  _issue: WatchIssue,
  _selected: boolean,
  _cols: number,
  _titleWidth?: number,
  _compact = false,
): number {
  return 1;
}
