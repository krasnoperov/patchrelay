import assert from "node:assert/strict";
import { deriveIssuePhase, type IssuePhaseInput, type IssuePhase } from "../src/issue-phase.ts";

export function assertIssuePhase(
  issue: (IssuePhaseInput & { phase?: IssuePhase | undefined }) | null | undefined,
  expected: IssuePhase,
  message?: string,
): void {
  assert.ok(issue, message ?? "expected an issue record");
  assert.equal(issue.phase ?? deriveIssuePhase(issue), expected, message);
}
