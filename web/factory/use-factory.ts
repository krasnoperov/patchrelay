import { useEffect, useState } from "react";
import type { FactorySnapshot } from "../../src/factory/types.ts";
import { createDemo } from "./demo.ts";

export function useFactory(demo: boolean, token: string) {
  const [snapshot, setSnapshot] = useState<FactorySnapshot | null>(
    demo ? createDemo : null,
  );
  const [connection, setConnection] = useState<
    "connecting" | "live" | "stale" | "auth" | "disabled"
  >("connecting");
  useEffect(() => {
    if (demo) {
      setSnapshot(createDemo());
      return;
    }
    setSnapshot(null);
    let stopped = false;
    let controller: AbortController;
    let reconnect: ReturnType<typeof setTimeout>;
    let watchdog: ReturnType<typeof setTimeout>;
    const connect = async () => {
      controller = new AbortController();
      setConnection("connecting");
      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          setConnection("stale");
          controller.abort();
        }, 20000);
      };
      armWatchdog();
      try {
        const response = await fetch("/api/factory/stream", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        if (response.status === 401) {
          setConnection("auth");
          return;
        }
        if (response.status === 404) {
          setConnection("disabled");
          return;
        }
        if (!response.ok || !response.body)
          throw new Error("Stream unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const message = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (message.startsWith("event: unavailable")) {
              setConnection("stale");
              continue;
            }
            if (!message.startsWith("data: ")) continue;
            const next = JSON.parse(message.slice(6)) as FactorySnapshot;
            if (!Array.isArray(next.projects) || !Array.isArray(next.sources))
              throw new Error("Invalid snapshot");
            if (!stopped) {
              setSnapshot(next);
              setConnection("live");
              armWatchdog();
            }
          }
        }
        if (!stopped) throw new Error("Stream closed");
      } catch {
        controller.abort();
        if (!stopped) {
          setConnection("stale");
          reconnect = setTimeout(connect, 5000);
        }
      } finally {
        clearTimeout(watchdog);
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(reconnect);
      clearTimeout(watchdog);
    };
  }, [demo, token]);
  return { snapshot, setSnapshot, connection };
}
