export function computeIssueListLayout(totalRows: number): {
  bodyRows: number;
  showBodyGap: boolean;
  showHelp: boolean;
} {
  const rows = Math.max(1, totalRows);
  const showBodyGap = rows >= 5;
  const showHelp = rows >= 8;
  const chromeRows = 1 + (showBodyGap ? 1 : 0) + (showHelp ? 2 : 0);
  return {
    bodyRows: Math.max(1, rows - chromeRows),
    showBodyGap,
    showHelp,
  };
}

export function computeVisibleWindowForTotal(
  total: number,
  selectedIndex: number,
  maxRows: number,
): { start: number; end: number } {
  if (total === 0) return { start: 0, end: 0 };
  const clamped = Math.max(0, Math.min(selectedIndex, total - 1));
  const half = Math.floor(maxRows / 2);
  let start = Math.max(0, clamped - half);
  let end = Math.min(total, start + maxRows);
  if (end - start < maxRows) {
    start = Math.max(0, end - maxRows);
  }
  return { start, end };
}

export function computeVisibleIssueParts(
  total: number,
  selectedIndex: number,
  rowBudget: number,
): { start: number; end: number; showAbove: boolean; showBelow: boolean } {
  if (total === 0 || rowBudget <= 0) {
    return { start: 0, end: 0, showAbove: false, showBelow: false };
  }

  let { start, end } = computeVisibleWindowForTotal(total, selectedIndex, Math.max(1, rowBudget));
  let hiddenAbove = start > 0;
  let hiddenBelow = end < total;

  if (rowBudget >= 3 && (hiddenAbove || hiddenBelow)) {
    const indicatorRows = (hiddenAbove ? 1 : 0) + (hiddenBelow ? 1 : 0);
    ({ start, end } = computeVisibleWindowForTotal(
      total,
      selectedIndex,
      Math.max(1, rowBudget - indicatorRows),
    ));
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
