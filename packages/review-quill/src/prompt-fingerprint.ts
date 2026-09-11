import { createHash } from "node:crypto";
import { selectReviewVisibleConversationClaims } from "./prompt-context/github-context.ts";
import type { PullRequestConversationClaim, PullRequestSummary } from "./types.ts";

export function buildPromptFingerprint(
  pr: Pick<PullRequestSummary, "title" | "body" | "labels">,
  conversationClaims: PullRequestConversationClaim[] = [],
): string {
  const payload = {
    v: 2,
    title: pr.title,
    body: pr.body ?? "",
    labels: [...pr.labels].sort(),
    conversationClaims: selectReviewVisibleConversationClaims(conversationClaims).map((claim) => ({
      authorLogin: claim.authorLogin ?? "",
      authorAssociation: claim.authorAssociation ?? "",
      createdAt: claim.createdAt,
      excerpt: claim.excerpt,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
