import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ReviewQuillWatchSnapshot } from "../types.ts";
import { fetchSnapshot, triggerReconcile } from "./api.ts";
import { DetailView } from "./DetailView.tsx";
import { HelpBar } from "./HelpBar.tsx";
import { ListView } from "./ListView.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { buildDashboard, repoSelector, stepRepo } from "./dashboard-model.ts";

interface AppProps {
  baseUrl: string;
}

const REFRESH_INTERVAL_MS = 1_500;

export function App({ baseUrl }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<ReviewQuillWatchSnapshot | null>(null);
  const [selectedRepoFullName, setSelectedRepoFullName] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  const [lastSnapshotReceivedAt, setLastSnapshotReceivedAt] = useState<number | null>(null);

  const model = useMemo(() => buildDashboard(snapshot), [snapshot]);

  useEffect(() => {
    setSelectedRepoFullName((current) => repoSelector(model.repos, current));
  }, [model]);

  useEffect(() => {
    if (!flashMessage) return;
    const timeout = setTimeout(() => setFlashMessage(null), 2500);
    return () => clearTimeout(timeout);
  }, [flashMessage]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await fetchSnapshot(baseUrl);
        if (cancelled) return;
        setSnapshot(next);
        setLastSnapshotReceivedAt(Date.now());
        setConnected(true);
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
  }, [baseUrl]);

  async function runReconcile(): Promise<void> {
    try {
      const result = await triggerReconcile(baseUrl);
      setFlashMessage(result.started ? "reconcile tick completed" : "reconcile already running");
      const next = await fetchSnapshot(baseUrl);
      setSnapshot(next);
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
    if (input === "j" || key.downArrow) {
      setSelectedRepoFullName((current) => stepRepo(model.repos, current, 1));
      return;
    }
    if (input === "k" || key.upArrow) {
      setSelectedRepoFullName((current) => stepRepo(model.repos, current, -1));
      return;
    }
    if (view === "list") {
      if (key.return) {
        setView("detail");
      }
      return;
    }
    if (key.escape || key.backspace || key.delete) {
      setView("list");
    }
  });

  return (
    <Box flexDirection="column">
      <StatusBar
        connected={connected}
        lastSnapshotReceivedAt={lastSnapshotReceivedAt}
      />
      {!snapshot ? (
        <Box marginTop={1}>
          <Text dimColor>Loading review-quill snapshot…</Text>
        </Box>
      ) : view === "detail" ? (
        <DetailView model={model} selectedRepoFullName={selectedRepoFullName} />
      ) : (
        <ListView
          model={model}
          selectedRepoFullName={selectedRepoFullName}
          showCursor={true}
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
