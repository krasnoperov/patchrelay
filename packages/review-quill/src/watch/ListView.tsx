import { Box, Text, useStdout } from "ink";
import type { DashboardModel, DashboardRepo, DashboardToken } from "./dashboard-model.ts";
import { formatRepoTokenText } from "./format.ts";
import {
  formatRepoTokensText,
  pickVisibleParts as pickVisibleIndexParts,
  pickVisibleWindow as pickVisibleIndexWindow,
} from "./compact-layout.ts";

interface ListViewProps {
  model: DashboardModel;
  selectedRepoFullName: string | null;
  showCursor: boolean;
  bodyRows: number;
  topMarginRows?: number | undefined;
}

function RepoTokens({ tokens, width }: { tokens: DashboardToken[]; width: number }): React.JSX.Element | null {
  const text = formatRepoTokensText(tokens, width);
  if (!text) return null;
  let offset = 0;
  const parts = text.split("  ").map((part) => {
    const token = tokens.find((candidate) => formatRepoTokenText(candidate) === part);
    const item = { text: part, token, offset };
    offset += part.length + 2;
    return item;
  });
  return (
    <Text>
      {parts.map((part, index) => (
        <Text
          key={`${part.text}-${part.offset}`}
          {...(part.token ? { color: part.token.color } : {})}
        >
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
  const repoLabelWidth = Math.min(28, Math.max(12, Math.floor(width * 0.35)));
  const tokenWidth = Math.max(6, width - repoLabelWidth - 3);
  const repoLabel = repo.repoFullName.length > repoLabelWidth
    ? repo.repoFullName.slice(0, repoLabelWidth)
    : repo.repoFullName.padEnd(repoLabelWidth, " ");
  return (
    <Box>
      <Text color={selected ? "cyan" : "gray"}>{showCursor && selected ? ">" : " "}</Text>
      <Text bold={selected}>{` ${repoLabel}  `}</Text>
      <RepoTokens tokens={repo.tokens} width={tokenWidth} />
    </Box>
  );
}

export function pickVisibleWindow(
  repos: DashboardRepo[],
  selectedIndex: number,
  availableRows: number,
): { start: number; end: number } {
  return pickVisibleIndexWindow(repos.length, selectedIndex, availableRows);
}

export function pickVisibleParts(
  repos: DashboardRepo[],
  selectedIndex: number,
  rowBudget: number,
): { start: number; end: number; showAbove: boolean; showBelow: boolean } {
  return pickVisibleIndexParts(repos.length, selectedIndex, rowBudget);
}

export function ListView({
  model,
  selectedRepoFullName,
  showCursor,
  bodyRows,
  topMarginRows = 1,
}: ListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const width = Math.max(40, stdout?.columns ?? 80);

  const total = model.repos.length;
  const selectedIndex = Math.max(0, model.repos.findIndex((repo) => repo.repoFullName === selectedRepoFullName));

  const { start, end, showAbove, showBelow } = pickVisibleParts(model.repos, selectedIndex, bodyRows);
  const visible = model.repos.slice(start, end);
  const above = start;
  const below = total - end;

  if (total === 0 || bodyRows <= 0) {
    return <Box marginTop={topMarginRows}><Text dimColor> </Text></Box>;
  }

  const children: React.JSX.Element[] = [];
  if (showAbove) {
    children.push(
      <Box key="above" paddingLeft={2}><Text dimColor>{`\u2191${above} more above`}</Text></Box>,
    );
  }
  for (const repo of visible) {
    children.push(
      <RepoRow
        key={repo.repoFullName}
        repo={repo}
        selected={repo.repoFullName === selectedRepoFullName}
        showCursor={showCursor}
        width={width - 2}
      />,
    );
  }
  if (showBelow) {
    children.push(
      <Box key="below" paddingLeft={2}><Text dimColor>{`\u2193${below} more below`}</Text></Box>,
    );
  }

  return (
    <Box flexDirection="column" marginTop={topMarginRows}>
      {children}
    </Box>
  );
}
