import type { IssueRecord } from "./db-types.ts";

export type IssueClass = "implementation" | "orchestration";
export type IssueClassSource = "explicit" | "hierarchy" | "heuristic" | "triage";

function hasExplicitNoCodePlanningSplitIntent(issue: Pick<IssueRecord, "title" | "description">): boolean {
  const text = [issue.title, issue.description].filter(Boolean).join("\n").toLowerCase();
  if (!text.trim()) return false;

  const noCodePlanning = [
    /\bno code\b/,
    /\bcode (?:is )?not (?:needed|required|part of this)\b/,
    /\bplanning only\b/,
    /\banalysis only\b/,
    /код[^\n.]{0,80}не делаем/,
    /без (?:изменени[яй]|правок) код[а]?/,
    /только анализ/,
    /только планирован/,
  ].some((pattern) => pattern.test(text));

  if (!noCodePlanning) return false;

  return [
    /\b(?:create|open|file|add|split|decompose|break down)[^\n.]{0,100}\b(?:child issues|follow-?up issues|issues|tickets|tasks)\b/,
    /\b(?:child issues|follow-?up issues|issues|tickets|tasks)[^\n.]{0,100}\b(?:create|open|file|add|split|decompose|break down)\b/,
    /(?:поставь|создай|заведи|добавь|разбей)[^\n.]{0,100}(?:задач|тикет|issue)/,
    /(?:задач|тикет|issue)[^\n.]{0,100}(?:поставь|создай|заведи|добавь|разбей)/,
  ].some((pattern) => pattern.test(text));
}

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

  if (params.issue.issueClassSource === "triage" && params.issue.issueClass) {
    return { issueClass: params.issue.issueClass, issueClassSource: "triage" };
  }

  if (hasExplicitNoCodePlanningSplitIntent(params.issue)) {
    return { issueClass: "orchestration", issueClassSource: "heuristic" };
  }

  return { issueClass: "implementation", issueClassSource: "heuristic" };
}
