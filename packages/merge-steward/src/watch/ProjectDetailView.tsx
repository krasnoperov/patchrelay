import { Box, Text, useStdout } from "ink";
import { RepoRow } from "./OverviewView.tsx";
import { clipSummary, type DashboardModel, type DashboardPrEntry, type DashboardRepo } from "./dashboard-model.ts";

interface ProjectDetailViewProps {
  model: DashboardModel;
  selectedRepoId: string | null;
}

const PR_ID_WIDTH = 7;
const SUMMARY_INDENT = 9;

function PrEntryRow({
  entry,
  width,
  includeSummary,
}: {
  entry: DashboardPrEntry;
  width: number;
  includeSummary: boolean;
}): React.JSX.Element {
  const idText = `#${entry.prNumber}`.padEnd(PR_ID_WIDTH, " ");
  const summaryText = includeSummary
    ? clipSummary(entry.summary, { maxLines: 3, width: Math.max(20, width - SUMMARY_INDENT) })
    : "";
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={entry.color}>{idText}</Text>
        <Text color={entry.color}>{entry.glyph}</Text>
        <Text>{`  ${entry.phrase}`}</Text>
      </Box>
      {summaryText ? (
        <Box>
          <Text>{" ".repeat(SUMMARY_INDENT)}</Text>
          <Text dimColor>{summaryText}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function ProjectDetailView({ model, selectedRepoId }: ProjectDetailViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = Math.max(3, stdout?.rows ?? 24);
  const width = Math.max(40, stdout?.columns ?? 80);

  const repo: DashboardRepo | null = selectedRepoId
    ? model.repos.find((candidate) => candidate.repoId === selectedRepoId) ?? model.repos[0] ?? null
    : model.repos[0] ?? null;

  if (!repo) {
    return <Box marginTop={1}><Text dimColor> </Text></Box>;
  }

  const availableRows = Math.max(1, rows - 3);
  const afterRepoRow = Math.max(0, availableRows - 2);
  const entries = repo.entries;

  type PlannedEntry = { entry: DashboardPrEntry; includeSummary: boolean };
  const planned: PlannedEntry[] = [];
  let used = 0;
  const maxSummaryLines = 3;

  for (const entry of entries) {
    if (used >= afterRepoRow) break;
    if (used + 1 > afterRepoRow) break;
    planned.push({ entry, includeSummary: false });
    used += 1;
  }

  if (afterRepoRow - used >= 2) {
    for (let i = 0; i < planned.length; i += 1) {
      const item = planned[i]!;
      if (!item.entry.summary) continue;
      const summaryText = clipSummary(item.entry.summary, {
        maxLines: maxSummaryLines,
        width: Math.max(20, width - SUMMARY_INDENT),
      });
      if (!summaryText) continue;
      const summaryLines = summaryText.split("\n").length;
      const isLast = i === planned.length - 1;
      const extra = summaryLines + (isLast ? 0 : 1);
      if (used + extra > afterRepoRow) break;
      item.includeSummary = true;
      used += extra;
    }
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <RepoRow repo={repo} selected={false} showCursor={false} width={width - 2} />
      {planned.length > 0 ? <Box><Text> </Text></Box> : null}
      {planned.map(({ entry, includeSummary }, index) => {
        const isLast = index === planned.length - 1;
        return (
          <Box key={entry.prNumber} flexDirection="column">
            <PrEntryRow entry={entry} width={width} includeSummary={includeSummary} />
            {includeSummary && !isLast ? <Box><Text> </Text></Box> : null}
          </Box>
        );
      })}
    </Box>
  );
}
