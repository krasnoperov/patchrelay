import { Box, Text, useStdout } from "ink";
import type { DashboardModel, DashboardRepo, DashboardToken } from "./dashboard-model.ts";

interface ListViewProps {
  model: DashboardModel;
  selectedRepoFullName: string | null;
  showCursor: boolean;
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
      <RepoTokens tokens={repo.tokens} width={tokenWidth} />
    </Box>
  );
}

export function ListView({ model, selectedRepoFullName, showCursor }: ListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = Math.max(3, stdout?.rows ?? 24);
  const width = Math.max(40, stdout?.columns ?? 80);

  const availableRows = Math.max(1, rows - 3);
  const selectedIndex = model.repos.findIndex((repo) => repo.repoFullName === selectedRepoFullName);
  const selected = selectedIndex >= 0 ? model.repos[selectedIndex]! : model.repos[0];
  const others = model.repos.filter((repo) => repo !== selected);

  const ordered: DashboardRepo[] = [];
  if (selected) ordered.push(selected);
  ordered.push(...others);

  const quietLine = model.quietCount > 0 ? 1 : 0;
  const maxRepoLines = Math.max(1, availableRows - quietLine);
  const visible = ordered.slice(0, maxRepoLines);
  const hiddenActive = ordered.length - visible.length;
  const quietFooter = model.quietCount + hiddenActive;

  if (visible.length === 0) {
    return <Box marginTop={1}><Text dimColor> </Text></Box>;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {visible.map((repo) => (
        <RepoRow
          key={repo.repoFullName}
          repo={repo}
          selected={repo === selected}
          showCursor={showCursor}
          width={width - 2}
        />
      ))}
      {quietFooter > 0 ? (
        <Box paddingLeft={2}>
          <Text dimColor>{`+${quietFooter} quiet`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
