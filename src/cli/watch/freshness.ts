export interface FreshnessStatus {
  label: string;
  color: "green" | "yellow" | "red";
}

const PATCHRELAY_FRESH_MS = 20_000;
const PATCHRELAY_STALE_MS = 40_000;

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${minutes}m` : `${minutes}m${String(rem).padStart(2, "0")}s`;
}

export function describePatchRelayFreshness(
  connected: boolean,
  lastServerMessageAt: number | null,
  now = Date.now(),
): FreshnessStatus {
  if (lastServerMessageAt === null) {
    return {
      label: connected ? "connecting" : "waiting for first server update",
      color: connected ? "yellow" : "red",
    };
  }

  const ageMs = Math.max(0, now - lastServerMessageAt);
  const age = formatAge(ageMs);

  if (!connected) {
    return { label: `disconnected · stale ${age}`, color: "red" };
  }
  if (ageMs > PATCHRELAY_STALE_MS) {
    return { label: `stream stalled? last server update ${age} ago`, color: "red" };
  }
  if (ageMs > PATCHRELAY_FRESH_MS) {
    return { label: `quiet ${age} since last server update`, color: "yellow" };
  }
  return { label: `fresh ${age}`, color: "green" };
}
