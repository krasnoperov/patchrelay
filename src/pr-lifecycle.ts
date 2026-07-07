export function isOpenPrState(prState: string | undefined): boolean {
  return prState === undefined || prState === "open";
}

export function hasOpenPr(prNumber: number | undefined, prState: string | undefined): boolean {
  // Transitional compatibility: older rows may still have a tracked PR number
  // before webhook/reconciliation has populated pr_state.
  return prNumber !== undefined && isOpenPrState(prState);
}

export function isClosedPrState(prState: string | undefined): boolean {
  return prState === "closed";
}
