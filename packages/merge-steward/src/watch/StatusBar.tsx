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
  gatewayError: string | null;
}

export function StatusBar({
  repos,
  currentRepo,
  view,
  filter,
  lastSnapshotReceivedAt,
  expectedFreshMs,
  gatewayError,
}: StatusBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const compact = width < 88;
  const cluster = getClusterSummary(repos);
  const connected = cluster.connected > 0;
  const repoHealth = currentRepo ? getRepoHealth(currentRepo) : null;
  const leftParts = view === "project" && currentRepo
    ? compact && currentRepo.repoId
      ? `ms ${currentRepo.repoId} ${repoHealth?.label ?? ""} a:${currentRepo.snapshot?.summary.active ?? 0} h:${currentRepo.snapshot?.summary.headPrNumber ?? "?"}`
      : [
        "merge-steward dashboard",
        currentRepo.repoId,
        repoHealth?.label ?? null,
        currentRepo.snapshot ? `${currentRepo.snapshot.summary.active} active` : null,
        currentRepo.snapshot?.summary.headPrNumber ? `head #${currentRepo.snapshot.summary.headPrNumber}` : "no head PR",
        `filter:${filter}`,
      ].filter(Boolean).join(" | ")
    : compact
      ? `${cluster.total}p ${cluster.connected}c ${cluster.active}a ${cluster.blocked}b`
      : [
        "merge-steward dashboard",
        `${cluster.total} projects`,
        `${cluster.connected} connected`,
        `${cluster.active} active`,
        `${cluster.blocked} blocked`,
        `${cluster.stuck} stuck`,
        `${cluster.attention} need attention`,
      ].join(" | ");
  const availableLeft = compact ? Math.max(1, width - 14) : Math.max(1, width - 28);

  return (
    <Box justifyContent="space-between">
      <Text bold>{truncate(leftParts, availableLeft)}</Text>
      <FreshnessBadge
        connected={connected}
        lastSnapshotReceivedAt={lastSnapshotReceivedAt}
        expectedFreshMs={expectedFreshMs}
        gatewayError={gatewayError}
      />
    </Box>
  );
}
