export interface GitHubStatusRollupEntry {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string;
}

export type GateCheckStatus = "pending" | "success" | "failure";

const FAILED_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);

function normalizeGateStatus(entry: GitHubStatusRollupEntry): GateCheckStatus {
  const status = entry.status?.trim().toLowerCase();
  if (status === "queued" || status === "in_progress" || status === "requested" || status === "waiting" || status === "pending") {
    return "pending";
  }

  const conclusion = entry.conclusion?.trim().toLowerCase();
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
    return "success";
  }
  if (conclusion && FAILED_CONCLUSIONS.has(conclusion)) {
    return "failure";
  }

  return status === "completed" ? "failure" : "pending";
}

export function deriveGateCheckStatusFromRollup(
  statusCheckRollup: GitHubStatusRollupEntry[] | undefined,
  gateCheckNames: string[],
): GateCheckStatus | undefined {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return undefined;
  }

  const expectedNames = gateCheckNames
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (expectedNames.length === 0) {
    return undefined;
  }

  const matches = statusCheckRollup.filter((entry) => {
    if (typeof entry?.name !== "string" || !entry.name.trim()) return false;
    return expectedNames.includes(entry.name.trim().toLowerCase());
  });
  if (matches.length === 0) {
    return undefined;
  }

  const normalized = matches.map((entry) => normalizeGateStatus(entry));
  if (normalized.some((status) => status === "pending")) return "pending";
  if (normalized.some((status) => status === "failure")) return "failure";
  return "success";
}
