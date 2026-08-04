export const PATCHRELAY_TASK_CONTRACT_START = "<!-- patchrelay-task-contract:v1:start -->";
export const PATCHRELAY_TASK_CONTRACT_END = "<!-- patchrelay-task-contract:v1:end -->";

export function extractPatchRelayTaskContract(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const start = body.indexOf(PATCHRELAY_TASK_CONTRACT_START);
  if (start === -1) return undefined;
  const contentStart = start + PATCHRELAY_TASK_CONTRACT_START.length;
  const end = body.indexOf(PATCHRELAY_TASK_CONTRACT_END, contentStart);
  if (end === -1) return undefined;
  const task = body.slice(contentStart, end).trim();
  return task || undefined;
}
