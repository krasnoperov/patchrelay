import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { QueueEntry, QueueEntryDetail, QueueWatchSnapshot } from "../types.ts";
import { dequeueEntry, fetchEntryDetail, fetchSnapshot, triggerReconcile } from "./api.ts";
import { DetailView } from "./DetailView.tsx";
import { HelpBar } from "./HelpBar.tsx";
import { QueueListView } from "./QueueListView.tsx";
import { StatusBar } from "./StatusBar.tsx";

interface AppProps {
  baseUrl: string;
  initialPrNumber?: number | undefined;
}

type WatchFilter = "active" | "all";
const REFRESH_INTERVAL_MS = 1_500;

function isActiveEntry(entry: QueueEntry): boolean {
  return entry.status !== "merged" && entry.status !== "evicted" && entry.status !== "dequeued";
}

function nextSelection(entries: QueueEntry[], selectedEntryId: string | null, direction: "next" | "prev"): string | null {
  if (entries.length === 0) {
    return null;
  }
  const index = entries.findIndex((entry) => entry.id === selectedEntryId);
  const currentIndex = index === -1 ? 0 : index;
  const nextIndex = direction === "next"
    ? (currentIndex + 1) % entries.length
    : (currentIndex - 1 + entries.length) % entries.length;
  return entries[nextIndex]?.id ?? null;
}

export function App({ baseUrl, initialPrNumber }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<QueueWatchSnapshot | null>(null);
  const [lastSnapshotReceivedAt, setLastSnapshotReceivedAt] = useState<number | null>(null);
  const [detail, setDetail] = useState<QueueEntryDetail | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");
  const [filter, setFilter] = useState<WatchFilter>("active");
  const [flashMessage, setFlashMessage] = useState<string | null>(null);

  const visibleEntries = useMemo(() => {
    const entries = snapshot?.entries ?? [];
    return filter === "active" ? entries.filter(isActiveEntry) : entries;
  }, [filter, snapshot?.entries]);

  const selectedEntry = useMemo(
    () => visibleEntries.find((entry) => entry.id === selectedEntryId) ?? null,
    [selectedEntryId, visibleEntries],
  );
  const activeEntries = useMemo(
    () => (snapshot?.entries ?? []).filter(isActiveEntry),
    [snapshot?.entries],
  );
  const selectedActiveIndex = useMemo(() => {
    if (!selectedEntryId) {
      return null;
    }
    const index = activeEntries.findIndex((entry) => entry.id === selectedEntryId);
    return index === -1 ? null : index + 1;
  }, [activeEntries, selectedEntryId]);
  const isHeadSelected = activeEntries[0]?.id === selectedEntryId;

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
        const nextSnapshot = await fetchSnapshot(baseUrl);
        if (cancelled) {
          return;
        }
        setSnapshot(nextSnapshot);
        setLastSnapshotReceivedAt(Date.now());
        setConnected(true);
        setSelectedEntryId((current) => {
          if (current && nextSnapshot.entries.some((entry) => entry.id === current)) {
            return current;
          }
          if (initialPrNumber !== undefined) {
            const match = nextSnapshot.entries.find((entry) => entry.prNumber === initialPrNumber);
            if (match) {
              return match.id;
            }
          }
          return nextSnapshot.summary.headEntryId ?? nextSnapshot.entries[0]?.id ?? null;
        });
      } catch (error) {
        if (!cancelled) {
          setConnected(false);
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
  }, [baseUrl, initialPrNumber]);

  useEffect(() => {
    if (view !== "detail" || !selectedEntryId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const nextDetail = await fetchEntryDetail(baseUrl, selectedEntryId);
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
  }, [baseUrl, selectedEntryId, view]);

  async function runReconcile(): Promise<void> {
    try {
      const result = await triggerReconcile(baseUrl);
      setFlashMessage(result.started ? "reconcile tick completed" : "reconcile already running");
      const nextSnapshot = await fetchSnapshot(baseUrl);
      setSnapshot(nextSnapshot);
      setLastSnapshotReceivedAt(Date.now());
      setConnected(true);
    } catch (error) {
      setFlashMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function runDequeue(): Promise<void> {
    if (!selectedEntryId) {
      return;
    }
    try {
      await dequeueEntry(baseUrl, selectedEntryId);
      setFlashMessage(`dequeued ${selectedEntry ? `#${selectedEntry.prNumber}` : "entry"}`);
      const nextSnapshot = await fetchSnapshot(baseUrl);
      setSnapshot(nextSnapshot);
      setLastSnapshotReceivedAt(Date.now());
      setConnected(true);
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
      void runReconcile();
      return;
    }
    if (input === "d") {
      void runDequeue();
      return;
    }

    if (view === "list") {
      if (input === "a") {
        setFilter((current) => (current === "active" ? "all" : "active"));
      } else if (input === "j" || key.downArrow) {
        setSelectedEntryId(nextSelection(visibleEntries, selectedEntryId, "next"));
      } else if (input === "k" || key.upArrow) {
        setSelectedEntryId(nextSelection(visibleEntries, selectedEntryId, "prev"));
      } else if (key.return && selectedEntryId) {
        setView("detail");
      }
      return;
    }

    if (key.escape || key.backspace || key.delete) {
      setView("list");
      return;
    }

    if (input === "j" || key.downArrow) {
      setSelectedEntryId(nextSelection(visibleEntries, selectedEntryId, "next"));
    } else if (input === "k" || key.upArrow) {
      setSelectedEntryId(nextSelection(visibleEntries, selectedEntryId, "prev"));
    }
  });

  return (
    <Box flexDirection="column">
      <StatusBar
        snapshot={snapshot}
        connected={connected}
        filter={filter}
        lastSnapshotReceivedAt={lastSnapshotReceivedAt}
        expectedFreshMs={REFRESH_INTERVAL_MS * 2}
      />
      {view === "list" ? (
        <QueueListView
          entries={visibleEntries}
          selectedEntryId={selectedEntryId}
          recentEvents={snapshot?.recentEvents ?? []}
          headEntryId={snapshot?.summary.headEntryId ?? null}
        />
      ) : (
        <DetailView
          detail={detail}
          isHead={isHeadSelected}
          activeIndex={selectedActiveIndex}
          activeCount={activeEntries.length}
          headPrNumber={snapshot?.summary.headPrNumber ?? null}
        />
      )}
      {flashMessage && (
        <Box marginTop={1}>
          <Text dimColor>{flashMessage}</Text>
        </Box>
      )}
      <HelpBar view={view} />
    </Box>
  );
}
