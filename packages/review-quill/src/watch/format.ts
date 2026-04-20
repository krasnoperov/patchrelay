export function relativeTime(value: string | number | null | undefined): string {
  if (!value) return "never";
  const timestamp = typeof value === "number" ? value : new Date(value).getTime();
  const deltaMs = Date.now() - timestamp;
  if (!Number.isFinite(deltaMs)) return "unknown";
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1_000));
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) return `${deltaHours}h`;
  return `${Math.floor(deltaHours / 24)}d`;
}

export function formatTokenAge(eventAt: number): string {
  return relativeTime(eventAt).padStart(4, " ");
}

export function formatRepoTokenText(token: { prNumber: number; glyph: string; eventAt: number }): string {
  return `#${token.prNumber} ${token.glyph} ${relativeTime(token.eventAt)}`;
}
