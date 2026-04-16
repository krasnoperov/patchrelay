import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { ReviewAttemptDetail, ReviewAttemptRecord, ReviewQuillWatchSnapshot } from "../types.ts";
import { fetchAttemptDetail, fetchSnapshot, triggerReconcile } from "./api.ts";
import { DetailView } from "./DetailView.tsx";
import { HelpBar } from "./HelpBar.tsx";
import { ListView } from "./ListView.tsx";
import { StatusBar } from "./StatusBar.tsx";

interface AppProps {
  baseUrl: string;
}

type WatchFilter = "active" | "all";
const REFRESH_INTERVAL_MS = 1_500;

function nextSelection(attempts: ReviewAttemptRecord[], selectedAttemptId: number | null, direction: "next" | "prev"): number | null {
  if (attempts.length === 0) {
    return null;
  }
  const index = attempts.findIndex((attempt) => attempt.id === selectedAttemptId);
  const currentIndex = index === -1 ? 0 : index;
  const nextIndex = direction === "next"
    ? (currentIndex + 1) % attempts.length
    : (currentIndex - 1 + attempts.length) % attempts.length;
  return attempts[nextIndex]?.id ?? null;
}

export function App({ baseUrl }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<ReviewQuillWatchSnapshot | null>(null);
  const [detail, setDetail] = useState<ReviewAttemptDetail | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState<number | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");
  const [filter, setFilter] = useState<WatchFilter>("active");
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  const [lastSnapshotReceivedAt, setLastSnapshotReceivedAt] = useState<number | null>(null);
  const width = Math.max(20, stdout?.columns ?? 80);
  const compact = width < 90;

  const visibleAttempts = useMemo(() => {
    const attempts = snapshot?.attempts ?? [];
    if (filter === "all") return attempts;
    return attempts.filter((attempt) => attempt.status === "queued" || attempt.status === "running");
  }, [filter, snapshot?.attempts]);

  const selectedRepoFullName = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    const selectedAttempt = snapshot.attempts.find((attempt) => attempt.id === selectedAttemptId);
    return selectedAttempt?.repoFullName ?? snapshot.repos[0]?.repoFullName ?? null;
  }, [selectedAttemptId, snapshot]);

  useEffect(() => {
    if (!flashMessage) return;
    const timeout = setTimeout(() => setFlashMessage(null), 2500);
    return () => clearTimeout(timeout);
  }, [flashMessage]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const nextSnapshot = await fetchSnapshot(baseUrl);
        if (cancelled) return;
        setSnapshot(nextSnapshot);
        setLastSnapshotReceivedAt(Date.now());
        setConnected(true);
        setSelectedAttemptId((current) => {
          if (current && nextSnapshot.attempts.some((attempt) => attempt.id === current)) {
            return current;
          }
          const nextVisible = filter === "all"
            ? nextSnapshot.attempts
            : nextSnapshot.attempts.filter((attempt) => attempt.status === "queued" || attempt.status === "running");
          return nextVisible[0]?.id ?? nextSnapshot.attempts[0]?.id ?? null;
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
  }, [baseUrl, filter]);

  useEffect(() => {
    if (view !== "detail" || !selectedAttemptId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const nextDetail = await fetchAttemptDetail(baseUrl, selectedAttemptId);
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
  }, [baseUrl, selectedAttemptId, view]);

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

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (input === "r") {
      void runReconcile();
      return;
    }
    if (view === "list") {
      if (input === "a") {
        setFilter((current) => current === "active" ? "all" : "active");
      } else if (input === "j" || key.downArrow) {
        setSelectedAttemptId(nextSelection(visibleAttempts, selectedAttemptId, "next"));
      } else if (input === "k" || key.upArrow) {
        setSelectedAttemptId(nextSelection(visibleAttempts, selectedAttemptId, "prev"));
      } else if (key.return && selectedAttemptId) {
        setView("detail");
      }
      return;
    }

    if (key.escape || key.backspace || key.delete) {
      setView("list");
      return;
    }
    if (input === "j" || key.downArrow) {
      setSelectedAttemptId(nextSelection(visibleAttempts, selectedAttemptId, "next"));
    } else if (input === "k" || key.upArrow) {
      setSelectedAttemptId(nextSelection(visibleAttempts, selectedAttemptId, "prev"));
    }
  });

  return (
    <Box flexDirection="column">
      <StatusBar
        snapshot={snapshot}
        connected={connected}
        filter={filter}
        lastSnapshotReceivedAt={lastSnapshotReceivedAt}
        compact={compact}
      />
      {view === "detail" && selectedAttemptId ? (
        <DetailView detail={detail} compact={compact} />
      ) : snapshot ? (
        <ListView
          snapshot={snapshot}
          attempts={visibleAttempts}
          selectedAttemptId={selectedAttemptId}
          selectedRepoFullName={selectedRepoFullName}
          compact={compact}
        />
      ) : (
        <Box marginTop={1}>
          <Text dimColor>Loading review-quill snapshot…</Text>
        </Box>
      )}
      {flashMessage ? (
        <Box marginTop={1}>
          <Text dimColor>{flashMessage}</Text>
        </Box>
      ) : null}
      <HelpBar view={view} compact={compact} />
    </Box>
  );
}
