import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { fetchGatewayHealth, fetchSnapshot, triggerReconcile } from "./api.ts";
import type { DashboardRepoConfig, DashboardRepoState } from "./dashboard-model.ts";
import { buildDashboard, matchRepoRef, repoSelector, stepRepo } from "./dashboard-model.ts";
import { HelpBar } from "./HelpBar.tsx";
import { OverviewView } from "./OverviewView.tsx";
import { ProjectDetailView } from "./ProjectDetailView.tsx";
import { StatusBar } from "./StatusBar.tsx";

interface AppProps {
  gatewayBaseUrl: string;
  repos: DashboardRepoConfig[];
  initialRepoRef?: string | undefined;
  initialPrNumber?: number | undefined;
}

const REFRESH_INTERVAL_MS = 1_500;

export function App({ gatewayBaseUrl, repos, initialRepoRef, initialPrNumber }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [repoStates, setRepoStates] = useState<DashboardRepoState[]>(() => repos.map((repo) => ({
    ...repo,
    serviceState: "offline",
    serviceMessage: null,
    snapshot: null,
    error: null,
    lastSnapshotReceivedAt: null,
  })));
  const [lastSnapshotReceivedAt, setLastSnapshotReceivedAt] = useState<number | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(() => {
    const initialRepo = repos.find((repo) => matchRepoRef(repo, initialRepoRef));
    return initialRepo?.repoId ?? repos[0]?.repoId ?? null;
  });
  const [view, setView] = useState<"list" | "detail">(
    initialRepoRef || initialPrNumber !== undefined ? "detail" : "list",
  );
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  const [pendingInitialPrNumber, setPendingInitialPrNumber] = useState<number | null>(initialPrNumber ?? null);
  const [detailScrollOffset, setDetailScrollOffset] = useState(0);

  const model = useMemo(() => buildDashboard(repoStates), [repoStates]);

  useEffect(() => {
    setSelectedRepoId((current) => repoSelector(model.repos, current));
  }, [model]);

  useEffect(() => {
    if (pendingInitialPrNumber === null) return;
    for (const repo of repoStates) {
      const match = repo.snapshot?.entries.find((entry) => entry.prNumber === pendingInitialPrNumber);
      if (match) {
        setSelectedRepoId(repo.repoId);
        setView("detail");
        setPendingInitialPrNumber(null);
        return;
      }
    }
  }, [pendingInitialPrNumber, repoStates]);

  useEffect(() => {
    if (!flashMessage) return;
    const timeout = setTimeout(() => setFlashMessage(null), 2500);
    return () => clearTimeout(timeout);
  }, [flashMessage]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const health = await fetchGatewayHealth(gatewayBaseUrl);
        if (!cancelled) setGatewayError(null);
        setRepoStates((current) => current.map((repo) => {
          const runtime = health.repos.find((candidate) => candidate.repoId === repo.repoId);
          if (!runtime) {
            return {
              ...repo,
              serviceState: "offline",
              serviceMessage: "Repo is not registered in the running merge-steward gateway.",
              snapshot: null,
            };
          }
          return {
            ...repo,
            serviceState: runtime.state,
            serviceMessage: runtime.state === "initializing"
              ? "Merge Steward is still initializing this repo."
              : runtime.state === "failed"
                ? runtime.lastError ?? "Repo initialization failed in merge-steward."
                : null,
            ...(runtime.state === "ready" ? {} : { snapshot: null }),
          };
        }));

        const readyRepoIds = health.repos.filter((repo) => repo.state === "ready").map((repo) => repo.repoId);
        const results = await Promise.all(readyRepoIds.map(async (repoId) => {
          try {
            const snapshot = await fetchSnapshot(gatewayBaseUrl, repoId);
            return { repoId, snapshot, receivedAt: Date.now(), error: null as string | null };
          } catch (error) {
            return {
              repoId,
              snapshot: null,
              receivedAt: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }));
        if (cancelled) return;

        setRepoStates((current) => current.map((repo) => {
          const result = results.find((candidate) => candidate.repoId === repo.repoId);
          if (!result) return repo;
          if (result.snapshot) {
            return {
              ...repo,
              snapshot: result.snapshot,
              error: null,
              lastSnapshotReceivedAt: result.receivedAt,
            };
          }
          return { ...repo, error: result.error };
        }));

        const latest = results.reduce<number | null>((max, result) => {
          if (result.receivedAt === null) return max;
          return max === null ? result.receivedAt : Math.max(max, result.receivedAt);
        }, null);
        if (latest !== null) setLastSnapshotReceivedAt(latest);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setGatewayError(message);
        setRepoStates((current) => current.map((repo) => ({
          ...repo,
          serviceState: "offline",
          serviceMessage: message,
          error: message,
        })));
      }
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gatewayBaseUrl, repos]);

  async function runReconcile(repoId: string | null): Promise<void> {
    if (!repoId) return;
    try {
      const result = await triggerReconcile(gatewayBaseUrl, repoId);
      setFlashMessage(result.started ? `reconcile tick completed for ${repoId}` : `reconcile already running for ${repoId}`);
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const rows = Math.max(8, stdout?.rows ?? 24);
  const chromeRows = 1 /* status */ + 1 /* body marginTop */ + (flashMessage ? 2 : 0) + 2 /* help bar + its marginTop */;
  const bodyRows = Math.max(2, rows - chromeRows);

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (input === "r") {
      void runReconcile(selectedRepoId);
      return;
    }

    if (view === "list") {
      if (input === "j" || key.downArrow || input === "]") {
        setSelectedRepoId((current) => stepRepo(model.repos, current, 1));
        return;
      }
      if (input === "k" || key.upArrow || input === "[") {
        setSelectedRepoId((current) => stepRepo(model.repos, current, -1));
        return;
      }
      if (key.return) setView("detail");
      return;
    }

    // detail view
    if (input === "]") {
      setSelectedRepoId((current) => stepRepo(model.repos, current, 1));
      setDetailScrollOffset(0);
      return;
    }
    if (input === "[") {
      setSelectedRepoId((current) => stepRepo(model.repos, current, -1));
      setDetailScrollOffset(0);
      return;
    }
    if (input === "j" || key.downArrow) {
      setDetailScrollOffset((offset) => offset + 1);
      return;
    }
    if (input === "k" || key.upArrow) {
      setDetailScrollOffset((offset) => Math.max(0, offset - 1));
      return;
    }
    if (key.pageDown || input === " ") {
      setDetailScrollOffset((offset) => offset + Math.max(1, bodyRows - 2));
      return;
    }
    if (key.pageUp) {
      setDetailScrollOffset((offset) => Math.max(0, offset - Math.max(1, bodyRows - 2)));
      return;
    }
    if (input === "g") {
      setDetailScrollOffset(0);
      return;
    }
    if (input === "G") {
      setDetailScrollOffset(Number.MAX_SAFE_INTEGER);
      return;
    }
    if (key.escape || key.backspace || key.delete) {
      setView("list");
      setDetailScrollOffset(0);
    }
  });

  return (
    <Box flexDirection="column">
      <StatusBar
        connected={model.repos.some((repo) => !repo.offlineMessage)}
        lastSnapshotReceivedAt={lastSnapshotReceivedAt}
        gatewayError={gatewayError}
      />
      {view === "detail" ? (
        <ProjectDetailView
          model={model}
          selectedRepoId={selectedRepoId}
          bodyRows={bodyRows}
          scrollOffset={detailScrollOffset}
        />
      ) : (
        <OverviewView
          model={model}
          selectedRepoId={selectedRepoId}
          showCursor={true}
          bodyRows={bodyRows}
        />
      )}
      {flashMessage ? (
        <Box marginTop={1}>
          <Text dimColor>{flashMessage}</Text>
        </Box>
      ) : null}
      <HelpBar view={view} />
    </Box>
  );
}
