export function isOpenPrState(prState: string | undefined): boolean {
  return prState === undefined || prState === "open";
}

export function hasOpenPr(prNumber: number | undefined, prState: string | undefined): boolean {
  return prNumber !== undefined && isOpenPrState(prState);
}

export function isClosedPrState(prState: string | undefined): boolean {
  return prState === "closed";
}
