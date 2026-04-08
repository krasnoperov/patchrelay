import { Box, Text, useStdout } from "ink";
import { ciStatusIcon, summarizeQueueBlock, truncate } from "./format.ts";
import type { DashboardRepoState } from "./dashboard-model.ts";
import { getChainEntries, getClusterSummary, getRepoHealth, projectStatsSummary } from "./dashboard-model.ts";

interface OverviewViewProps {
  repos: DashboardRepoState[];
  selectedRepoId: string | null;
}

function clampWindowStart(selectedIndex: number, itemCount: number, maxItems: number): number {
  if (itemCount <= maxItems) {
    return 0;
  }
  const half = Math.floor(maxItems / 2);
  return Math.max(0, Math.min(itemCount - maxItems, selectedIndex - half));
}

export function OverviewView({ repos, selectedRepoId }: OverviewViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cluster = getClusterSummary(repos);
  const selectedIndex = Math.max(0, repos.findIndex((repo) => repo.repoId === selectedRepoId));
  const maxItems = Math.max(1, Math.floor((rows - 8) / 2));
  const startIndex = clampWindowStart(selectedIndex, repos.length, maxItems);
  const visibleRepos = repos.slice(startIndex, startIndex + maxItems);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Queue Overview</Text>
      <Text dimColor>
        {cluster.total} projects · {cluster.connected} connected · {cluster.active} active · {cluster.blocked} blocked · {cluster.stuck} stuck · {cluster.attention} need attention
      </Text>
      {repos.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No repositories are attached yet. Run {"`merge-steward repo attach <owner/repo>`"} first.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {visibleRepos.map((repo) => {
            const health = getRepoHealth(repo);
            const queueBlockSummary = summarizeQueueBlock(repo.snapshot?.queueBlock);
            const chainEntries = getChainEntries(repo.snapshot);
            const chainText = repo.snapshot
              ? chainEntries.length > 0
                ? chainEntries.map((entry) => {
                  const ci = ciStatusIcon(entry);
                  return `#${entry.prNumber} ${ci.icon}`;
                }).join("  ")
                : "queue is empty"
              : "queue data unavailable";
            return (
              <Box key={repo.repoId} flexDirection="column">
                <Box>
                  <Text color={repo.repoId === selectedRepoId ? "cyan" : "gray"}>{repo.repoId === selectedRepoId ? "\u25b8" : " "}</Text>
                  <Text bold>{repo.repoId}</Text>
                  <Text dimColor>{`  ${truncate(repo.repoFullName, 28)}`}</Text>
                  <Text>{`  `}</Text>
                  <Text color={health.color}>{health.label}</Text>
                  <Text dimColor>{`  ${projectStatsSummary(repo.snapshot)}`}</Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text dimColor>{`Queue: ${truncate(chainText, 100)}`}</Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text color={health.color}>{truncate(queueBlockSummary ?? health.detail, 110)}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
