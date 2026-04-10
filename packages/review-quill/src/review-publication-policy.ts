import type { PullRequestReviewRecord } from "./types.ts";
import type {
  PullRequestSummary,
  ReviewFinding,
  ReviewVerdict,
} from "./types.ts";

// Findings below this confidence score are dropped before posting.
// Empirical; tunable. Claude Code plugin uses 80 as its default. We
// start at 70 - slightly more permissive - and can raise if noise creeps
// back in.
export const REVIEW_FINDING_CONFIDENCE_THRESHOLD = 70;

// Guard against a runaway model producing 100 inline comments. Matches
// PR-Agent's `num_max_findings` cap philosophy.
export const REVIEW_MAX_INLINE_COMMENTS = 20;

function reviewStateForEvent(event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"): "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" {
  switch (event) {
    case "APPROVE": return "APPROVED";
    case "REQUEST_CHANGES": return "CHANGES_REQUESTED";
    case "COMMENT": return "COMMENTED";
  }
}

function normalizeReviewerLogin(login: string | undefined): string | undefined {
  return login?.replace(/\[bot\]$/i, "");
}

function matchesReviewerLogin(authorLogin: string | undefined, reviewerLogin: string | undefined): boolean {
  const normalizedAuthor = normalizeReviewerLogin(authorLogin);
  const normalizedReviewer = normalizeReviewerLogin(reviewerLogin);
  return Boolean(normalizedAuthor && normalizedReviewer && normalizedAuthor === normalizedReviewer);
}

function isDecisiveReviewState(state: string | undefined): state is "APPROVED" | "CHANGES_REQUESTED" {
  return state === "APPROVED" || state === "CHANGES_REQUESTED";
}

export type PublicationDisposition =
  | { action: "publish" }
  | { action: "supersede"; summary: string; checkConclusion: "cancelled" }
  | { action: "cancel"; summary: string; checkConclusion: "cancelled" };

// Drop findings the model was not confident in, then cap the total
// count so a runaway model can't spam 100 inline comments.
//
// Also drop findings that point at files the model invented - any
// path not in `knownPaths` gets silently removed. The diff inventory
// is the authoritative list of files the model could actually review,
// so a finding pointing outside of it is always a hallucination.
export function filterFindings(findings: ReviewFinding[], knownPaths?: Set<string>): ReviewFinding[] {
  const confident = findings.filter((f) => (f.confidence ?? 100) >= REVIEW_FINDING_CONFIDENCE_THRESHOLD);
  const withKnownPath = knownPaths
    ? confident.filter((f) => knownPaths.has(f.path))
    : confident;
  // Keep blocking findings first, then nits, up to the cap.
  const sorted = [...withKnownPath].sort((a, b) => {
    if (a.severity === b.severity) return (b.confidence ?? 100) - (a.confidence ?? 100);
    return a.severity === "blocking" ? -1 : 1;
  });
  return sorted.slice(0, REVIEW_MAX_INLINE_COMMENTS);
}

// Map the agent's verdict + findings to the GitHub review event. Enforces
// "nits never block": even if the model asked for REQUEST_CHANGES, if
// there are no blocking findings we demote to COMMENT. This is the same
// rule `normalizeVerdict` enforces in review-runner, but we re-apply it
// here after the confidence filter (which might have removed the
// blocking finding that justified request_changes in the first place).
export function resolveEvent(verdict: ReviewVerdict, filtered: ReviewFinding[]): "APPROVE" | "REQUEST_CHANGES" {
  const hasBlocking = filtered.some((f) => f.severity === "blocking")
    || verdict.architectural_concerns.some((c) => c.severity === "blocking");
  if (hasBlocking) return "REQUEST_CHANGES";
  return "APPROVE";
}

// Build the review body (posted into the `body` field of the GitHub
// review, i.e. the walkthrough comment at the top). Structured as:
//   1. Walkthrough narrative
//   2. Architectural concerns section (if any)
//   3. Final verdict line with rationale
export function buildReviewBody(params: {
  verdict: ReviewVerdict;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
}): string {
  const { verdict, event } = params;
  const lines: string[] = [];

  lines.push(verdict.walkthrough.trim());

  if (verdict.architectural_concerns.length > 0) {
    lines.push("", "## Architectural concerns");
    for (const concern of verdict.architectural_concerns) {
      const marker = concern.severity === "blocking" ? "🚨" : "💡";
      lines.push(`- ${marker} **[${concern.category}]** ${concern.message}`);
    }
  }

  lines.push("");
  const verdictLabel = event === "APPROVE"
    ? "✅ Approve"
    : event === "REQUEST_CHANGES"
      ? "🛑 Request changes"
      : "💬 Comment";
  lines.push(`**Verdict: ${verdictLabel}** — ${verdict.verdict_reason}`);

  return lines.join("\n");
}

// Format a single inline comment body: severity marker + message + optional
// committable suggestion block. The 6-line rule from Claude Code is
// enforced here: suggestions longer than 6 lines are dropped (we keep
// the message describing the fix, but don't inject a suggestion block
// that the reviewer would have to manually trim).
export function buildInlineCommentBody(finding: ReviewFinding): string {
  const marker = finding.severity === "blocking" ? "🚨" : "💡";
  const header = `${marker} ${finding.message}`;
  if (finding.suggestion) {
    const snippetLines = finding.suggestion.split("\n").length;
    if (snippetLines <= 6) {
      return `${header}\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
    }
  }
  return header;
}

export function findStaleDecisiveReviews(params: {
  reviews: PullRequestReviewRecord[];
  reviewerLogin: string | undefined;
  headSha: string;
}): PullRequestReviewRecord[] {
  if (!params.reviewerLogin) {
    return [];
  }

  return [...params.reviews]
    .reverse()
    .filter((review) => matchesReviewerLogin(review.authorLogin, params.reviewerLogin)
      && review.commitId !== undefined
      && review.commitId !== params.headSha
      && isDecisiveReviewState(review.state));
}

// Decide whether we should skip posting the new review because the
// existing one (from us, on the same head SHA) is already equivalent.
//
// Equivalence means BOTH:
//   - the review state matches (APPROVED / CHANGES_REQUESTED / COMMENTED)
//   - the rendered body is byte-identical
//
// The body comparison closes the gap where two runs on the same head
// produce the same verdict but different walkthroughs / findings - we
// want the new content visible to the author instead of silently
// keeping the stale content. Inline comments are deterministic from
// the body (both are derived from the same findings array), so body
// equality is a sufficient proxy; we don't need to diff comments too.
export function hasMatchingLatestReviewForHead(
  reviews: PullRequestReviewRecord[],
  reviewerLogin: string | undefined,
  headSha: string,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  newBody?: string,
): boolean {
  if (!reviewerLogin) return false;
  const desiredState = reviewStateForEvent(event);
  const latest = [...reviews]
    .reverse()
    .find((review) => matchesReviewerLogin(review.authorLogin, reviewerLogin) && review.commitId === headSha);
  if (latest?.state !== desiredState) return false;
  // State matches. If we were given a newBody to compare, require
  // byte-equality too. If not (backward compat), the state match is
  // enough.
  if (newBody !== undefined && latest.body !== newBody) return false;
  return true;
}

export function classifyPublicationDisposition(
  currentPr: Pick<PullRequestSummary, "state" | "isDraft" | "headSha">,
  reviewedHeadSha: string,
): PublicationDisposition {
  if (currentPr.headSha && currentPr.headSha !== reviewedHeadSha) {
    return {
      action: "supersede",
      summary: `Superseded by newer head ${currentPr.headSha.slice(0, 12)} before review publication`,
      checkConclusion: "cancelled",
    };
  }
  if (currentPr.state !== "open" && currentPr.state !== "OPEN") {
    return {
      action: "cancel",
      summary: `Cancelled because the PR is ${currentPr.state.toLowerCase()} before review publication`,
      checkConclusion: "cancelled",
    };
  }
  if (currentPr.isDraft) {
    return {
      action: "cancel",
      summary: "Cancelled because the PR returned to draft before review publication",
      checkConclusion: "cancelled",
    };
  }
  return { action: "publish" };
}
