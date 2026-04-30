import type { DashboardModel, DashboardRepo, DashboardToken } from "./dashboard-model.ts";
import { formatRepoTokenText } from "./format.ts";

export function computeDashboardLayout(totalRows: number, hasFlashMessage: boolean): {
  bodyRows: number;
  bodyTopMarginRows: number;
  showFlashMessage: boolean;
  showHelp: boolean;
} {
  const rows = Math.max(1, totalRows);
  const bodyTopMarginRows = rows >= 5 ? 1 : 0;
  const showFlashMessage = hasFlashMessage && rows >= 6;
  const showHelp = rows >= 8;
  const chromeRows = 1
    + bodyTopMarginRows
    + (showFlashMessage ? 2 : 0)
    + (showHelp ? 2 : 0);

  return {
    bodyRows: Math.max(1, rows - chromeRows),
    bodyTopMarginRows,
    showFlashMessage,
    showHelp,
  };
}

export function pickVisibleWindow(
  total: number,
  selectedIndex: number,
  availableRows: number,
): { start: number; end: number } {
  if (total === 0) return { start: 0, end: 0 };
  if (total <= availableRows) return { start: 0, end: total };
  const clamped = Math.max(0, Math.min(selectedIndex, total - 1));
  let start = clamped;
  let end = clamped + 1;
  while (end - start < availableRows) {
    if (start > 0 && (end === total || clamped - start <= end - 1 - clamped)) {
      start -= 1;
    } else if (end < total) {
      end += 1;
    } else {
      break;
    }
  }
  return { start, end };
}

export function pickVisibleParts(
  total: number,
  selectedIndex: number,
  rowBudget: number,
): { start: number; end: number; showAbove: boolean; showBelow: boolean } {
  if (total === 0 || rowBudget <= 0) {
    return { start: 0, end: 0, showAbove: false, showBelow: false };
  }

  let { start, end } = pickVisibleWindow(total, selectedIndex, Math.max(1, rowBudget));
  let hiddenAbove = start > 0;
  let hiddenBelow = end < total;

  if (rowBudget >= 3 && (hiddenAbove || hiddenBelow)) {
    const indicatorRows = (hiddenAbove ? 1 : 0) + (hiddenBelow ? 1 : 0);
    ({ start, end } = pickVisibleWindow(total, selectedIndex, Math.max(1, rowBudget - indicatorRows)));
    hiddenAbove = start > 0;
    hiddenBelow = end < total;
  }

  const usedRows = end - start;
  let remaining = Math.max(0, rowBudget - usedRows);
  const showAbove = hiddenAbove && remaining > 0;
  if (showAbove) remaining -= 1;
  const showBelow = hiddenBelow && remaining > 0;

  return { start, end, showAbove, showBelow };
}

export function formatRepoTokensText(tokens: DashboardToken[], width: number): string | null {
  if (tokens.length === 0 || width < 6) return null;
  const parts: string[] = [];
  let used = 0;
  for (const token of tokens) {
    const text = formatRepoTokenText(token);
    const separatorWidth = parts.length === 0 ? 0 : 2;
    if (used + separatorWidth + text.length > width) break;
    used += separatorWidth + text.length;
    parts.push(text);
  }
  return parts.join("  ");
}

export function formatRepoRowText({
  repo,
  selected,
  showCursor,
  width,
}: {
  repo: DashboardRepo;
  selected: boolean;
  showCursor: boolean;
  width: number;
}): string {
  const cursorChar = showCursor && selected ? ">" : " ";
  const repoLabelWidth = Math.min(28, Math.max(12, Math.floor(width * 0.35)));
  const tokenWidth = Math.max(6, width - repoLabelWidth - 3);
  const repoLabel = repo.repoFullName.length > repoLabelWidth
    ? repo.repoFullName.slice(0, repoLabelWidth)
    : repo.repoFullName.padEnd(repoLabelWidth, " ");
  return `${cursorChar} ${repoLabel}  ${formatRepoTokensText(repo.tokens, tokenWidth) ?? ""}`;
}

export function renderListLines({
  model,
  selectedRepoFullName,
  showCursor,
  bodyRows,
  topMarginRows = 1,
  width,
}: {
  model: DashboardModel;
  selectedRepoFullName: string | null;
  showCursor: boolean;
  bodyRows: number;
  topMarginRows?: number | undefined;
  width: number;
}): string[] {
  const total = model.repos.length;
  const selectedIndex = Math.max(0, model.repos.findIndex((repo) => repo.repoFullName === selectedRepoFullName));

  const lines = Array.from({ length: topMarginRows }, () => "");
  if (total === 0 || bodyRows <= 0) {
    lines.push(" ");
    return lines;
  }

  const { start, end, showAbove, showBelow } = pickVisibleParts(total, selectedIndex, bodyRows);
  const visible = model.repos.slice(start, end);
  const above = start;
  const below = total - end;
  if (showAbove) {
    lines.push(`  \u2191${above} more above`);
  }
  for (const repo of visible) {
    lines.push(formatRepoRowText({
      repo,
      selected: repo.repoFullName === selectedRepoFullName,
      showCursor,
      width: width - 2,
    }));
  }
  if (showBelow) {
    lines.push(`  \u2193${below} more below`);
  }
  return lines;
}
