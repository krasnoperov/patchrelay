import type { IssueRecord } from "./db-types.ts";

export type IssueClass = "implementation" | "orchestration";
export type IssueClassSource = "explicit" | "hierarchy" | "heuristic";

function normalizeText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function looksLikeUmbrellaText(issue: Pick<IssueRecord, "title" | "description">): boolean {
  const haystack = `${normalizeText(issue.title)}\n${normalizeText(issue.description)}`;
  if (!haystack.trim()) return false;
  return [
    "umbrella",
    "tracker",
    "tracking",
    "rollout",
    "migration",
    "convergence",
    "audit",
    "follow-up issues",
    "planning/specification issue only",
  ].some((token) => haystack.includes(token));
}

export function classifyIssue(params: {
  issue: Pick<IssueRecord, "issueClass" | "issueClassSource" | "title" | "description" | "parentLinearIssueId">;
  childIssueCount: number;
}): { issueClass: IssueClass; issueClassSource: IssueClassSource } {
  if (
    params.issue.issueClassSource === "explicit"
    && (params.issue.issueClass === "implementation" || params.issue.issueClass === "orchestration")
  ) {
    return { issueClass: params.issue.issueClass, issueClassSource: "explicit" };
  }

  if (params.issue.parentLinearIssueId) {
    return { issueClass: "implementation", issueClassSource: "hierarchy" };
  }

  if (params.childIssueCount > 0) {
    return { issueClass: "orchestration", issueClassSource: "hierarchy" };
  }

  if (looksLikeUmbrellaText(params.issue)) {
    return { issueClass: "orchestration", issueClassSource: "heuristic" };
  }

  return { issueClass: "implementation", issueClassSource: "heuristic" };
}
