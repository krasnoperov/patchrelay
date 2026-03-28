export interface SnapshotFreshness {
  label: string;
  color: "green" | "yellow" | "red";
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${minutes}m` : `${minutes}m${String(rem).padStart(2, "0")}s`;
}

export function describeSnapshotFreshness(
  connected: boolean,
  lastSnapshotReceivedAt: number | null,
  expectedFreshMs: number,
  now = Date.now(),
): SnapshotFreshness {
  if (lastSnapshotReceivedAt === null) {
    return {
      label: connected ? "connecting" : "waiting for first snapshot",
      color: connected ? "yellow" : "red",
    };
  }

  const ageMs = Math.max(0, now - lastSnapshotReceivedAt);
  const age = formatAge(ageMs);

  if (!connected) {
    return { label: `disconnected · stale ${age}`, color: "red" };
  }
  if (ageMs > expectedFreshMs * 3) {
    return { label: `snapshot lag? last refresh ${age} ago`, color: "red" };
  }
  if (ageMs > expectedFreshMs) {
    return { label: `refresh delayed ${age}`, color: "yellow" };
  }
  return { label: `fresh ${age}`, color: "green" };
}
