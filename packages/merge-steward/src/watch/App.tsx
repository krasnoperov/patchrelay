import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { QueueEntryDetail } from "../types.ts";
import { dequeueEntry, fetchEntryDetail, fetchGatewayHealth, fetchSnapshot, triggerReconcile } from "./api.ts";
import type { DashboardRepoConfig, DashboardRepoState } from "./dashboard-model.ts";
import { getDefaultEntryId, getVisibleEntries, matchRepoRef } from "./dashboard-model.ts";
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

type WatchFilter = "active" | "all";
const REFRESH_INTERVAL_MS = 1_500;

function nextSelection<T extends { id: string }>(items: T[], selectedId: string | null, direction: "next" | "prev"): string | null {
  if (items.length === 0) {
    return null;
  }
  const index = items.findIndex((item) => item.id === selectedId);
  const currentIndex = index === -1 ? 0 : index;
  const nextIndex = direction === "next"
    ? (currentIndex + 1) % items.length
    : (currentIndex - 1 + items.length) % items.length;
  return items[nextIndex]?.id ?? null;
}

export function App({ gatewayBaseUrl, repos, initialRepoRef, initialPrNumber }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [repoStates, setRepoStates] = useState<DashboardRepoState[]>(() => repos.map((repo) => ({
    ...repo,
    snapshot: null,
    error: null,
    lastSnapshotReceivedAt: null,
  })));
  const [lastSnapshotReceivedAt, setLastSnapshotReceivedAt] = useState<number | null>(null);
  const [detail, setDetail] = useState<QueueEntryDetail | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(() => {
    const initialRepo = repos.find((repo) => matchRepoRef(repo, initialRepoRef));
    return initialRepo?.repoId ?? repos[0]?.repoId ?? null;
  });
  const [selectedEntryIds, setSelectedEntryIds] = useState<Record<string, string | null>>({});
  const [view, setView] = useState<"overview" | "project">(
    initialRepoRef || initialPrNumber !== undefined ? "project" : "overview",
  );
  const [filter, setFilter] = useState<WatchFilter>("active");
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  const [pendingInitialPrNumber, setPendingInitialPrNumber] = useState<number | null>(initialPrNumber ?? null);

  const repoSelectionItems = useMemo(
    () => repoStates.map((repo) => ({ id: repo.repoId })),
    [repoStates],
  );
  const currentRepo = useMemo(
    () => repoStates.find((repo) => repo.repoId === selectedRepoId) ?? null,
    [repoStates, selectedRepoId],
  );
  const currentVisibleEntries = useMemo(
    () => getVisibleEntries(currentRepo?.snapshot ?? null, filter),
    [currentRepo?.snapshot, filter],
  );
  const selectedEntryId = currentRepo ? (selectedEntryIds[currentRepo.repoId] ?? null) : null;

  useEffect(() => {
    if (!flashMessage) {
      return;
    }
    const timeout = setTimeout(() => setFlashMessage(null), 2500);
    return () => clearTimeout(timeout);
  }, [flashMessage]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        await fetchGatewayHealth(gatewayBaseUrl);
        if (!cancelled) {
          setGatewayError(null);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setGatewayError(message);
        setRepoStates((current) => current.map((repo) => ({
          ...repo,
          error: message,
        })));
        return;
      }

      const results = await Promise.all(repos.map(async (repo) => {
        try {
          const snapshot = await fetchSnapshot(gatewayBaseUrl, repo.repoId);
          return { repoId: repo.repoId, snapshot, receivedAt: Date.now(), error: null as string | null };
        } catch (error) {
          return {
            repoId: repo.repoId,
            snapshot: null,
            receivedAt: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }));

      if (cancelled) {
        return;
      }

      setRepoStates((current) => current.map((repo) => {
        const result = results.find((candidate) => candidate.repoId === repo.repoId);
        if (!result) {
          return repo;
        }
        if (result.snapshot) {
          return {
            ...repo,
            snapshot: result.snapshot,
            error: null,
            lastSnapshotReceivedAt: result.receivedAt,
          };
        }
        return {
          ...repo,
          error: result.error,
        };
      }));

      const latest = results.reduce<number | null>((max, result) => {
        if (result.receivedAt === null) {
          return max;
        }
        return max === null ? result.receivedAt : Math.max(max, result.receivedAt);
      }, null);
      if (latest !== null) {
        setLastSnapshotReceivedAt(latest);
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

  useEffect(() => {
    if (pendingInitialPrNumber === null) {
      return;
    }
    for (const repo of repoStates) {
      const match = repo.snapshot?.entries.find((entry) => entry.prNumber === pendingInitialPrNumber);
      if (!match) {
        continue;
      }
      setSelectedRepoId(repo.repoId);
      setSelectedEntryIds((current) => ({
        ...current,
        [repo.repoId]: match.id,
      }));
      setView("project");
      setPendingInitialPrNumber(null);
      return;
    }
  }, [pendingInitialPrNumber, repoStates]);

  useEffect(() => {
    if (!currentRepo) {
      return;
    }
    const nextDefault = getDefaultEntryId(currentRepo.snapshot, filter, pendingInitialPrNumber);
    setSelectedEntryIds((current) => {
      const existing = current[currentRepo.repoId];
      if (existing && currentVisibleEntries.some((entry) => entry.id === existing)) {
        return current;
      }
      if (existing === nextDefault) {
        return current;
      }
      return {
        ...current,
        [currentRepo.repoId]: nextDefault,
      };
    });
  }, [currentRepo, currentVisibleEntries, filter, pendingInitialPrNumber]);

  useEffect(() => {
    if (view !== "project" || !currentRepo?.repoId || !selectedEntryId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const nextDetail = await fetchEntryDetail(gatewayBaseUrl, currentRepo.repoId, selectedEntryId);
        if (!cancelled) {
          setDetail(nextDetail);
        }
      } catch (error) {
        if (!cancelled) {
          setFlashMessage(error instanceof Error ? error.message : String(error));
        }
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
  }, [gatewayBaseUrl, currentRepo?.repoId, selectedEntryId, view]);

  async function refreshRepo(repoId: string): Promise<void> {
    const nextSnapshot = await fetchSnapshot(gatewayBaseUrl, repoId);
    const receivedAt = Date.now();
    setRepoStates((current) => current.map((repo) => repo.repoId === repoId
      ? { ...repo, snapshot: nextSnapshot, error: null, lastSnapshotReceivedAt: receivedAt }
      : repo));
    setLastSnapshotReceivedAt(receivedAt);
  }

  async function runReconcile(repoId: string | null): Promise<void> {
    if (!repoId) {
      return;
    }
    try {
      const result = await triggerReconcile(gatewayBaseUrl, repoId);
      setFlashMessage(result.started ? `reconcile tick completed for ${repoId}` : `reconcile already running for ${repoId}`);
      await refreshRepo(repoId);
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function runDequeue(): Promise<void> {
    if (!currentRepo?.repoId || !selectedEntryId) {
      return;
    }
    try {
      const selectedEntry = currentRepo.snapshot?.entries.find((entry) => entry.id === selectedEntryId) ?? null;
      await dequeueEntry(gatewayBaseUrl, currentRepo.repoId, selectedEntryId);
      setFlashMessage(`dequeued ${selectedEntry ? `#${selectedEntry.prNumber}` : "entry"} from ${currentRepo.repoId}`);
      await refreshRepo(currentRepo.repoId);
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : String(error));
    }
  }

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (input === "r") {
      void runReconcile(selectedRepoId);
      return;
    }

    if (view === "overview") {
      if (input === "j" || key.downArrow) {
        setSelectedRepoId(nextSelection(repoSelectionItems, selectedRepoId, "next"));
      } else if (input === "k" || key.upArrow) {
        setSelectedRepoId(nextSelection(repoSelectionItems, selectedRepoId, "prev"));
      } else if (key.return && selectedRepoId) {
        setView("project");
      }
      return;
    }

    if (input === "d") {
      void runDequeue();
      return;
    }
    if (key.escape || key.backspace || key.delete) {
      setView("overview");
      return;
    }

    if (input === "a") {
      setFilter((current) => current === "active" ? "all" : "active");
    } else if (input === "j" || key.downArrow) {
      if (currentRepo?.repoId) {
        setSelectedEntryIds((current) => ({
          ...current,
          [currentRepo.repoId]: nextSelection(currentVisibleEntries, current[currentRepo.repoId] ?? null, "next"),
        }));
      }
    } else if (input === "k" || key.upArrow) {
      if (currentRepo?.repoId) {
        setSelectedEntryIds((current) => ({
          ...current,
          [currentRepo.repoId]: nextSelection(currentVisibleEntries, current[currentRepo.repoId] ?? null, "prev"),
        }));
      }
    }
  });

  return (
    <Box flexDirection="column">
      <StatusBar
        repos={repoStates}
        currentRepo={currentRepo}
        view={view}
        filter={filter}
        lastSnapshotReceivedAt={lastSnapshotReceivedAt}
        expectedFreshMs={REFRESH_INTERVAL_MS * 2}
        gatewayError={gatewayError}
      />
      {view === "overview" ? (
        <OverviewView repos={repoStates} selectedRepoId={selectedRepoId} gatewayError={gatewayError} />
      ) : (
        <ProjectDetailView
          repo={currentRepo}
          selectedEntryId={selectedEntryId}
          detail={detail}
          filter={filter}
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
