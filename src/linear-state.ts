export function isCompletedLinearState(
  currentLinearStateType: string | undefined,
  currentLinearState: string | undefined,
): boolean {
  const normalizedType = currentLinearStateType?.trim().toLowerCase();
  const normalizedName = currentLinearState?.trim().toLowerCase();
  return normalizedType === "completed"
    || normalizedName === "done"
    || normalizedName === "completed"
    || normalizedName === "complete";
}

export function isCanceledLinearState(
  currentLinearStateType: string | undefined,
  currentLinearState: string | undefined,
): boolean {
  const normalizedType = currentLinearStateType?.trim().toLowerCase();
  const normalizedName = currentLinearState?.trim().toLowerCase();
  return normalizedType === "canceled"
    || normalizedType === "cancelled"
    || normalizedName === "canceled"
    || normalizedName === "cancelled"
    || normalizedName === "duplicate";
}

export function isTerminalLinearState(
  currentLinearStateType: string | undefined,
  currentLinearState: string | undefined,
): boolean {
  return isCompletedLinearState(currentLinearStateType, currentLinearState)
    || isCanceledLinearState(currentLinearStateType, currentLinearState);
}
