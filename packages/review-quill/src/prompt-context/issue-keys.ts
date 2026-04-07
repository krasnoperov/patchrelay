import type { PullRequestSummary } from "../types.ts";

const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

function collectMatches(text: string | undefined, sink: Set<string>): void {
  if (!text) return;
  for (const match of text.matchAll(ISSUE_KEY_RE)) {
    const key = match[1]?.trim().toUpperCase();
    if (key) sink.add(key);
  }
}

export function detectIssueKeys(pr: Pick<PullRequestSummary, "title" | "body" | "headRefName">): string[] {
  const matches = new Set<string>();
  collectMatches(pr.title, matches);
  collectMatches(pr.body, matches);
  collectMatches(pr.headRefName, matches);
  return [...matches];
}
