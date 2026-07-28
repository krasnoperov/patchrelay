import type { ReviewFinding, ReviewVerdict } from "./types.ts";
import {
  buildInlineCommentBody,
  buildReviewBody,
  filterFindings,
  resolveEvent,
} from "./review-publication-policy.ts";

export type ReviewSubmitEvent = ReturnType<typeof resolveEvent>;

export interface RenderedReviewArtifacts {
  reviewBody: string;
  inlineComments: Array<{ path: string; line: number; side: "RIGHT"; body: string }>;
  filteredFindings: ReviewFinding[];
  event: ReviewSubmitEvent;
  dropStats: { droppedTotal: number; droppedByPath: number; droppedByConfidence: number };
  useBodyOnly: boolean;
}

export interface RenderReviewArtifactsInput {
  verdict: ReviewVerdict;
  inventoryPaths: string[];
}

/**
 * Pure function that turns a model verdict + diff inventory into the GitHub
 * artifacts to publish — review body, inline comments, the chosen event, and
 * drop stats for logging. No side effects, no DB, no GitHub I/O; this is what
 * makes the publication policy testable without standing up a fake GitHub.
 *
 */
export function renderReviewArtifacts(input: RenderReviewArtifactsInput): RenderedReviewArtifacts {
  const knownPaths = new Set(input.inventoryPaths);
  const filteredFindings = filterFindings(input.verdict.findings, knownPaths);
  const droppedTotal = input.verdict.findings.length - filteredFindings.length;
  const droppedByPath = input.verdict.findings.filter((f) => !knownPaths.has(f.path)).length;
  const droppedByConfidence = droppedTotal - droppedByPath;

  const event = resolveEvent(input.verdict, filteredFindings);
  const reviewBody = buildReviewBody({ verdict: input.verdict, event });
  const inlineComments = filteredFindings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: "RIGHT" as const,
    body: buildInlineCommentBody(finding),
  }));

  return {
    reviewBody,
    inlineComments,
    filteredFindings,
    event,
    dropStats: { droppedTotal, droppedByPath, droppedByConfidence },
    useBodyOnly: false,
  };
}
