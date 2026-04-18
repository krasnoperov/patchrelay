import { Box, Text, useStdout } from "ink";
import type { DashboardModel, DashboardRepo, DashboardToken } from "./dashboard-model.ts";

interface ListViewProps {
  model: DashboardModel;
  selectedRepoId: string | null;
  showCursor: boolean;
  bodyRows: number;
}

function RepoTokens({ tokens, width }: { tokens: DashboardToken[]; width: number }): React.JSX.Element | null {
  if (tokens.length === 0 || width < 6) return null;
  const parts: { token: DashboardToken; text: string }[] = [];
  let used = 0;
  for (const token of tokens) {
    const text = `#${token.prNumber} ${token.glyph}`;
    const separatorWidth = parts.length === 0 ? 0 : 2;
    if (used + separatorWidth + text.length > width) break;
    used += separatorWidth + text.length;
    parts.push({ token, text });
  }
  return (
    <Text>
      {parts.map((part, index) => (
        <Text key={`${part.token.prNumber}-${index}`} color={part.token.color}>
          {index === 0 ? part.text : `  ${part.text}`}
        </Text>
      ))}
    </Text>
  );
}

export function RepoRow({
  repo,
  selected,
  showCursor,
  width,
}: {
  repo: DashboardRepo;
  selected: boolean;
  showCursor: boolean;
  width: number;
}): React.JSX.Element {
  const cursorChar = showCursor && selected ? ">" : " ";
  const repoLabelWidth = Math.min(28, Math.max(12, Math.floor(width * 0.35)));
  const tokenWidth = Math.max(6, width - repoLabelWidth - 3);
  const repoLabel = repo.repoFullName.length > repoLabelWidth
    ? repo.repoFullName.slice(0, repoLabelWidth)
    : repo.repoFullName.padEnd(repoLabelWidth, " ");
  return (
    <Box>
      <Text color={selected ? "cyan" : "gray"}>{cursorChar}</Text>
      <Text bold={selected}>{` ${repoLabel}  `}</Text>
      {repo.offlineMessage ? (
        <Text color="red">{repo.offlineMessage}</Text>
      ) : (
        <RepoTokens tokens={repo.tokens} width={tokenWidth} />
      )}
    </Box>
  );
}

export function pickVisibleWindow(
  total: number,
  selectedIndex: number,
  availableRows: number,
): { start: number; end: number } {
  if (total === 0) return { start: 0, end: 0 };
  if (total <= availableRows) return { start: 0, end: total };
  const clamped = Math.max(0, Math.min(selectedIndex, total - 1));
  let start = clamped;
  let end = clamped + 1;
  while (end - start < availableRows) {
    if (start > 0 && (end === total || clamped - start <= end - 1 - clamped)) {
      start -= 1;
    } else if (end < total) {
      end += 1;
    } else {
      break;
    }
  }
  return { start, end };
}

export function OverviewView({ model, selectedRepoId, showCursor, bodyRows }: ListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const width = Math.max(40, stdout?.columns ?? 80);

  const total = model.repos.length;
  const selectedIndex = Math.max(0, model.repos.findIndex((repo) => repo.repoId === selectedRepoId));

  let { start, end } = pickVisibleWindow(total, selectedIndex, Math.max(1, bodyRows));
  let needTop = start > 0;
  let needBottom = end < total;
  if (needTop || needBottom) {
    const reserve = (needTop ? 1 : 0) + (needBottom ? 1 : 0);
    const windowRows = Math.max(1, bodyRows - reserve);
    ({ start, end } = pickVisibleWindow(total, selectedIndex, windowRows));
    needTop = start > 0;
    needBottom = end < total;
  }
  const visible = model.repos.slice(start, end);
  const above = start;
  const below = total - end;

  if (total === 0 || bodyRows <= 0) {
    return <Box marginTop={1}><Text dimColor> </Text></Box>;
  }

  const children: React.JSX.Element[] = [];
  if (needTop) {
    children.push(
      <Box key="above" paddingLeft={2}><Text dimColor>{`\u2191${above} more above`}</Text></Box>,
    );
  }
  for (const repo of visible) {
    children.push(
      <RepoRow
        key={repo.repoId}
        repo={repo}
        selected={repo.repoId === selectedRepoId}
        showCursor={showCursor}
        width={width - 2}
      />,
    );
  }
  if (needBottom) {
    children.push(
      <Box key="below" paddingLeft={2}><Text dimColor>{`\u2193${below} more below`}</Text></Box>,
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {children.slice(0, Math.max(1, bodyRows))}
    </Box>
  );
}
