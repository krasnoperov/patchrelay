export function planStepSymbol(status: string): string {
  if (status === "completed") return "\u2713";
  if (status === "inProgress") return "\u25b8";
  return " ";
}

export function planStepColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "inProgress") return "yellow";
  return "white";
}
