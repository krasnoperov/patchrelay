import { Box, Text, useStdout } from "ink";
import { ciStatusIcon, summarizeQueueBlock, truncate } from "./format.ts";
import type { DashboardRepoState } from "./dashboard-model.ts";
import { getClusterSummary, getRepoHealth, projectStatsSummary } from "./dashboard-model.ts";
import { getChainEntries } from "./dashboard-model.ts";

interface OverviewViewProps {
  repos: DashboardRepoState[];
  selectedRepoId: string | null;
  gatewayError: string | null;
}

function clampWindowStart(selectedIndex: number, itemCount: number, maxItems: number): number {
  if (itemCount <= maxItems) {
    return 0;
  }
  const half = Math.floor(maxItems / 2);
  return Math.max(0, Math.min(itemCount - maxItems, selectedIndex - half));
}

export function OverviewView({ repos, selectedRepoId, gatewayError }: OverviewViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const width = stdout?.columns ?? 80;
  const compact = width < 90;
  const cluster = getClusterSummary(repos);
  const selectedIndex = Math.max(0, repos.findIndex((repo) => repo.repoId === selectedRepoId));
  const maxItems = Math.max(1, Math.floor((rows - 8) / 2));
  const startIndex = clampWindowStart(selectedIndex, repos.length, maxItems);
  const visibleRepos = repos.slice(startIndex, startIndex + maxItems);
  const summaryText = compact
    ? `${cluster.total}p ${cluster.connected}c ${cluster.active}a ${cluster.blocked}b ${cluster.stuck}s`
    : `${cluster.total} projects · ${cluster.connected} connected · ${cluster.active} active · ${cluster.blocked} blocked · ${cluster.stuck} stuck · ${cluster.attention} need attention`;
  const idWidth = compact ? Math.max(14, Math.min(24, Math.floor(width * 0.44))) : 18;
  const chainWidth = compact ? Math.max(12, width - 10) : 100;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Queue Overview</Text>
      <Text dimColor>{summaryText}</Text>
      {gatewayError ? (
        <Text color="red">{`Gateway offline: ${truncate(gatewayError, 88)}. Run \`merge-steward service restart\`.`}</Text>
      ) : null}
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
                  return compact
                    ? `#${entry.prNumber}${ci.icon}`
                    : `#${entry.prNumber} ${ci.icon}`;
                }).join(" ")
                : compact ? "empty" : "queue is empty"
              : "queue data unavailable";
            return (
              <Box key={repo.repoId} flexDirection="column">
                <Box>
                  <Text color={repo.repoId === selectedRepoId ? "cyan" : "gray"}>{repo.repoId === selectedRepoId ? ">" : " "}</Text>
                  <Text bold>{truncate(repo.repoId, idWidth)}</Text>
                  {compact ? null : <Text dimColor>{`  ${truncate(repo.repoFullName, 28)}`}</Text>}
                  <Text>{`  `}</Text>
                  <Text color={health.color}>{compact ? health.label.slice(0, 5) : health.label}</Text>
                  <Text dimColor>{`  ${projectStatsSummary(repo.snapshot, compact)}`}</Text>
                </Box>
                <Box paddingLeft={2}>
                  <Text dimColor>{`Queue: ${truncate(chainText, chainWidth)}`}</Text>
                </Box>
                {compact ? null : (
                  <Box paddingLeft={2}>
                    <Text color={health.color}>{truncate(queueBlockSummary ?? health.detail, 110)}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
