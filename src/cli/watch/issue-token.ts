import type { WatchIssue } from "./watch-state.ts";
import { isUndelegatedPausedIssue } from "../../paused-issue-state.ts";
import {
  hasFailedPrChecks,
  hasPendingPrChecks,
  isApprovedReviewState,
  isAwaitingReviewState,
  isChangesRequestedReviewState,
  prChecksFact,
} from "./pr-status.ts";

export type IssueTokenColor = "red" | "yellow" | "green" | "gray";

export type IssueTokenKind =
  | "running"
  | "queued"
  | "approved"
  | "declined"
  | "attention";

export interface IssueToken {
  glyph: string;
  color: IssueTokenColor;
  kind: IssueTokenKind;
  phrase: string;
}

export interface PrTokenDisplay {
  prNumber: number;
  glyph: string;
  color: IssueTokenColor;
  kind: IssueTokenKind;
  phrase: string;
}

const GLYPH: Record<IssueTokenKind, string> = {
  running: "\u25cf",
  queued: "\u25cb",
  approved: "\u2713",
  declined: "\u2717",
  attention: "\u26a0",
};

const COLOR: Record<IssueTokenKind, IssueTokenColor> = {
  running: "yellow",
  queued: "gray",
  approved: "green",
  declined: "red",
  attention: "red",
};

export function issueTokenFor(issue: WatchIssue): IssueToken {
  if (isUndelegatedPausedIssue(issue)) {
    return { glyph: GLYPH.queued, color: COLOR.queued, kind: "queued", phrase: phraseForPaused(issue) };
  }
  if (issue.factoryState === "done") {
    return { glyph: GLYPH.approved, color: COLOR.approved, kind: "approved", phrase: "done" };
  }
  if (issue.factoryState === "failed") {
    return { glyph: GLYPH.declined, color: COLOR.declined, kind: "declined", phrase: "failed" };
  }
  if (issue.factoryState === "escalated") {
    return { glyph: GLYPH.attention, color: COLOR.attention, kind: "attention", phrase: "escalated" };
  }
  if (issue.factoryState === "awaiting_input" || issue.sessionState === "waiting_input") {
    return { glyph: GLYPH.attention, color: COLOR.attention, kind: "attention", phrase: "needs human" };
  }
  if (issue.factoryState === "delegated") {
    return { glyph: GLYPH.queued, color: COLOR.queued, kind: "queued", phrase: "delegated" };
  }
  return {
    glyph: GLYPH.running,
    color: COLOR.running,
    kind: "running",
    phrase: phraseForRunning(issue),
  };
}

function phraseForRunning(issue: WatchIssue): string {
  switch (issue.factoryState) {
    case "implementing":
      return "implementing";
    case "pr_open":
      return "pr open";
    case "changes_requested":
      return "changes requested";
    case "repairing_ci":
      return "repairing ci";
    case "awaiting_queue":
      return "awaiting queue";
    case "repairing_queue":
      return "repairing queue";
    default:
      return issue.factoryState;
  }
}

function phraseForPaused(issue: WatchIssue): string {
  switch (issue.factoryState) {
    case "implementing":
      return "paused impl";
    case "pr_open":
      return "paused pr";
    case "changes_requested":
      return "paused review";
    case "repairing_ci":
      return "paused ci";
    case "awaiting_queue":
      return "paused queue";
    case "repairing_queue":
      return "paused merge";
    default:
      return "paused";
  }
}

export function prTokenFor(issue: WatchIssue): PrTokenDisplay | null {
  if (issue.prNumber === undefined) return null;
  const kind = prKind(issue);
  return {
    prNumber: issue.prNumber,
    glyph: GLYPH[kind],
    color: COLOR[kind],
    kind,
    phrase: prPhraseFor(issue),
  };
}

function prKind(issue: WatchIssue): IssueTokenKind {
  if (issue.prState === "merged") return "approved";
  if (issue.prState === "closed") return "declined";
  if (issue.prReviewState === "approved") return "approved";
  if (issue.prReviewState === "changes_requested") return "declined";
  if (issue.prChecksSummary?.overall === "failure" || issue.prCheckStatus === "failure") return "declined";
  if (issue.prChecksSummary?.overall === "success" || issue.prCheckStatus === "success") return "approved";
  return "running";
}

function prPhraseFor(issue: WatchIssue): string {
  if (issue.prState === "merged") return "merged";
  if (issue.prState === "closed") return "closed";
  if (isChangesRequestedReviewState(issue.prReviewState)) return "changes req";
  if (isApprovedReviewState(issue.prReviewState)) return "approved";
  if (isAwaitingReviewState(issue.prReviewState)) return "awaiting review";
  if (hasFailedPrChecks(issue)) return prChecksFact(issue)?.text ?? "checks failed";
  if (hasPendingPrChecks(issue)) return prChecksFact(issue)?.text ?? "checks running";
  return prChecksFact(issue)?.text ?? "open";
}
