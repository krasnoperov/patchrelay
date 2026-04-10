import { describePatchRelayFreshness } from "./freshness.ts";
import type { TextSegment } from "./render-rich-text.ts";

export interface DetailStatusInput {
  follow: boolean;
  unreadBelow: number;
  activeRunStartedAt: string | null;
  connected: boolean;
  lastServerMessageAt: number | null;
}

export function buildDetailStatusSegments(
  input: DetailStatusInput,
  now: number = Date.now(),
): TextSegment[] {
  const groups: TextSegment[][] = [];

  groups.push(input.follow
    ? [{ text: "live edge", color: "green", bold: true }]
    : [{ text: "anchored review", color: "yellow", bold: true }]);

  if (input.unreadBelow > 0) {
    groups.push([{ text: `${input.unreadBelow} new below`, color: "yellow", bold: true }]);
  }

  if (input.activeRunStartedAt) {
    groups.push([{ text: `run ${formatElapsed(input.activeRunStartedAt, now)}`, dimColor: true }]);
  }

  const freshness = describePatchRelayFreshness(input.connected, input.lastServerMessageAt, now);
  groups.push([{ text: freshness.label, color: freshness.color, bold: true }]);

  return joinGroups(groups);
}

function formatElapsed(startedAt: string, now: number): string {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return "0m 00s";
  const elapsed = Math.max(0, Math.floor((now - startedMs) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function joinGroups(groups: TextSegment[][]): TextSegment[] {
  const segments: TextSegment[] = [];
  for (const [index, group] of groups.entries()) {
    if (index > 0) {
      segments.push({ text: "  ", dimColor: true });
    }
    segments.push(...group);
  }
  return segments;
}
