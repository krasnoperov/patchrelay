import { Box, Text, useStdout } from "ink";
import type { DashboardRepoState } from "./dashboard-model.ts";
import { getClusterSummary, getRepoHealth } from "./dashboard-model.ts";
import { truncate } from "./format.ts";
import { FreshnessBadge } from "./FreshnessBadge.tsx";

interface StatusBarProps {
  repos: DashboardRepoState[];
  currentRepo: DashboardRepoState | null;
  view: "overview" | "project";
  filter: "active" | "all";
  lastSnapshotReceivedAt: number | null;
  expectedFreshMs: number;
}

export function StatusBar({
  repos,
  currentRepo,
  view,
  filter,
  lastSnapshotReceivedAt,
  expectedFreshMs,
}: StatusBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const cluster = getClusterSummary(repos);
  const connected = cluster.connected > 0;
  const repoHealth = currentRepo ? getRepoHealth(currentRepo) : null;
  const leftParts = view === "project" && currentRepo
    ? [
      "merge-steward dashboard",
      currentRepo.repoId,
      repoHealth?.label ?? null,
      currentRepo.snapshot ? `${currentRepo.snapshot.summary.active} active` : null,
      currentRepo.snapshot?.summary.headPrNumber ? `head #${currentRepo.snapshot.summary.headPrNumber}` : "no head PR",
      `filter:${filter}`,
    ].filter(Boolean).join(" | ")
    : [
      "merge-steward dashboard",
      `${cluster.total} projects`,
      `${cluster.connected} connected`,
      `${cluster.active} active`,
      `${cluster.blocked} blocked`,
      `${cluster.stuck} stuck`,
      `${cluster.attention} need attention`,
    ].join(" | ");
  const availableLeft = Math.max(1, width - 28);

  return (
    <Box justifyContent="space-between">
      <Text bold>{truncate(leftParts, availableLeft)}</Text>
      <FreshnessBadge
        connected={connected}
        lastSnapshotReceivedAt={lastSnapshotReceivedAt}
        expectedFreshMs={expectedFreshMs}
      />
    </Box>
  );
}
