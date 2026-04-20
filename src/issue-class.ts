import type { IssueRecord } from "./db-types.ts";

export type IssueClass = "implementation" | "orchestration";
export type IssueClassSource = "explicit" | "hierarchy" | "heuristic";

export function classifyIssue(params: {
  issue: Pick<IssueRecord, "issueClass" | "issueClassSource" | "title" | "description" | "parentLinearIssueId">;
  childIssueCount: number;
}): { issueClass: IssueClass; issueClassSource: IssueClassSource } {
  if (params.issue.parentLinearIssueId) {
    return { issueClass: "implementation", issueClassSource: "hierarchy" };
  }

  if (params.childIssueCount > 0) {
    if (params.issue.issueClassSource === "explicit" && params.issue.issueClass === "orchestration") {
      return { issueClass: "orchestration", issueClassSource: "explicit" };
    }
    return { issueClass: "orchestration", issueClassSource: "hierarchy" };
  }

  if (params.issue.issueClassSource === "explicit" && params.issue.issueClass === "implementation") {
    return { issueClass: "implementation", issueClassSource: "explicit" };
  }

  return { issueClass: "implementation", issueClassSource: "heuristic" };
}
