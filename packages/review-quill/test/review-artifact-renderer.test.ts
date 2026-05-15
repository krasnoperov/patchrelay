import assert from "node:assert/strict";
import test from "node:test";
import { renderReviewArtifacts } from "../src/review-artifact-renderer.ts";
import type { ReviewVerdict } from "../src/types.ts";

function baseVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    verdict: "approve",
    verdict_reason: "Looks fine",
    walkthrough: "Walkthrough",
    findings: [],
    architectural_concerns: [],
    ...overrides,
  } as ReviewVerdict;
}

test("renderReviewArtifacts produces inline comments for head-mode reviews", () => {
  const artifacts = renderReviewArtifacts({
    verdict: baseVerdict({
      verdict: "request_changes",
      verdict_reason: "Fix the bug",
      findings: [
        {
          path: "src/a.ts",
          line: 10,
          severity: "blocking",
          message: "Bug",
          confidence: 100,
        } as never,
      ],
    }),
    inventoryPaths: ["src/a.ts"],
    surfaceMode: "head",
  });
  assert.equal(artifacts.useBodyOnly, false);
  assert.equal(artifacts.event, "REQUEST_CHANGES");
  assert.equal(artifacts.inlineComments.length, 1);
  assert.equal(artifacts.inlineComments[0]?.path, "src/a.ts");
  assert.equal(artifacts.inlineComments[0]?.line, 10);
  assert.equal(artifacts.inlineComments[0]?.side, "RIGHT");
});

test("renderReviewArtifacts forces body-only output in integration_tree mode", () => {
  const artifacts = renderReviewArtifacts({
    verdict: baseVerdict({
      verdict: "request_changes",
      findings: [
        {
          path: "src/a.ts",
          line: 10,
          severity: "blocking",
          message: "Bug",
          confidence: 100,
        } as never,
      ],
    }),
    inventoryPaths: ["src/a.ts"],
    surfaceMode: "integration_tree",
  });
  assert.equal(artifacts.useBodyOnly, true);
  assert.deepEqual(artifacts.inlineComments, []);
  assert.match(artifacts.reviewBody, /Bug/);
});

test("renderReviewArtifacts drops findings whose path is outside the diff inventory", () => {
  const artifacts = renderReviewArtifacts({
    verdict: baseVerdict({
      verdict: "request_changes",
      findings: [
        { path: "src/a.ts", line: 1, severity: "blocking", message: "in diff", confidence: 100 } as never,
        { path: "src/unknown.ts", line: 1, severity: "blocking", message: "hallucinated", confidence: 100 } as never,
      ],
    }),
    inventoryPaths: ["src/a.ts"],
    surfaceMode: "head",
  });
  assert.equal(artifacts.filteredFindings.length, 1);
  assert.equal(artifacts.filteredFindings[0]?.path, "src/a.ts");
  assert.equal(artifacts.dropStats.droppedTotal, 1);
  assert.equal(artifacts.dropStats.droppedByPath, 1);
  assert.equal(artifacts.dropStats.droppedByConfidence, 0);
});

test("renderReviewArtifacts reports APPROVE event when no blocking findings survive", () => {
  const artifacts = renderReviewArtifacts({
    verdict: baseVerdict({ verdict: "approve", findings: [] }),
    inventoryPaths: [],
    surfaceMode: "head",
  });
  assert.equal(artifacts.event, "APPROVE");
  assert.equal(artifacts.inlineComments.length, 0);
});
