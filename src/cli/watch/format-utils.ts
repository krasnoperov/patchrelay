/** Format ISO timestamp as HH:MM:SS (24h, en-GB). */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

/** Format ISO timestamp as compact relative time: "3s", "12m", "2h", "5d". */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Format millisecond duration as "2m 30s" or "45s". */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Format token count with k/M suffix. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Truncate text to max length with ellipsis. Collapses newlines. */
export function truncate(text: string, max: number): string {
  const line = text.replace(/\n/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}
