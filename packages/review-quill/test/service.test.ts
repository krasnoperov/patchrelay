import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInlineCommentBody,
  buildReviewBody,
  classifyPublicationDisposition,
  filterFindings,
  hasMatchingLatestReviewForHead,
  resolveEvent,
} from "../src/service.ts";
import { normalizeVerdict } from "../src/review-runner.ts";
import { extractFirstJsonObject, forgivingJsonParse, sanitizeJsonPayload } from "../src/utils.ts";
import type { ReviewFinding, ReviewVerdict } from "../src/types.ts";

function fakeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: "src/foo.ts",
    line: 42,
    severity: "blocking",
    message: "null pointer dereference",
    ...overrides,
  };
}

function fakeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    walkthrough: "This PR changes the admission flow.",
    architectural_concerns: [],
    findings: [],
    verdict: "approve",
    verdict_reason: "No issues found.",
    ...overrides,
  };
}

test("hasMatchingLatestReviewForHead skips resubmission when latest reviewer verdict already matches the head (state-only)", () => {
  const reviews = [
    {
      id: 1,
      authorLogin: "review-quill",
      state: "CHANGES_REQUESTED",
      commitId: "older-sha",
    },
    {
      id: 2,
      authorLogin: "review-quill",
      state: "APPROVED",
      commitId: "head-sha",
    },
  ];

  // Backward-compatible signature (no newBody): state-only match.
  assert.equal(hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "APPROVE"), true);
  assert.equal(hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "REQUEST_CHANGES"), false);
  assert.equal(hasMatchingLatestReviewForHead(reviews, "someone-else", "head-sha", "APPROVE"), false);
});

test("hasMatchingLatestReviewForHead requires body byte-equality when newBody is supplied", () => {
  const reviews = [
    {
      id: 1,
      authorLogin: "review-quill",
      state: "APPROVED",
      commitId: "head-sha",
      body: "Walkthrough v1",
    },
  ];
  // Same body → skip
  assert.equal(
    hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "APPROVE", "Walkthrough v1"),
    true,
  );
  // Different body → don't skip; we want the new content posted
  assert.equal(
    hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "APPROVE", "Walkthrough v2"),
    false,
  );
});

test("hasMatchingLatestReviewForHead does not skip when state matches but the body is missing on the existing review", () => {
  // If GitHub returned the review without a body field (rare but
  // possible), we cannot prove equality and should err on the side of
  // re-posting rather than silently swallowing the new content.
  const reviews = [
    {
      id: 1,
      authorLogin: "review-quill",
      state: "APPROVED",
      commitId: "head-sha",
      // body intentionally absent
    },
  ];
  assert.equal(
    hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "APPROVE", "Some body"),
    false,
  );
});

test("hasMatchingLatestReviewForHead matches COMMENTED state for comment event", () => {
  const reviews = [
    {
      id: 1,
      authorLogin: "review-quill",
      state: "COMMENTED",
      commitId: "head-sha",
    },
  ];
  assert.equal(hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "COMMENT"), true);
  assert.equal(hasMatchingLatestReviewForHead(reviews, "review-quill", "head-sha", "APPROVE"), false);
});

test("classifyPublicationDisposition marks stale heads as superseded", () => {
  const disposition = classifyPublicationDisposition({
    state: "OPEN",
    isDraft: false,
    headSha: "new-head-sha",
  }, "old-head-sha");

  assert.equal(disposition.action, "supersede");
});

test("normalizeVerdict accepts the rich schema and passes it through", () => {
  const raw = {
    walkthrough: "This PR refactors the admission loop and fixes a race condition.",
    architectural_concerns: [
      { severity: "nit", category: "convention", message: "Inconsistent error handling across the new admission code." },
    ],
    findings: [
      { path: "src/admission.ts", line: 142, severity: "blocking", message: "Missing mutex release on error path", confidence: 90 },
      { path: "src/admission.ts", line: 198, severity: "nit", message: "Consider renaming for clarity", confidence: 60 },
    ],
    verdict: "request_changes",
    verdict_reason: "One blocking finding on the error path.",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.walkthrough, raw.walkthrough);
  assert.equal(result.verdict, "request_changes");
  assert.equal(result.architectural_concerns.length, 1);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0]?.confidence, 90);
  assert.equal(result.verdict_reason, "One blocking finding on the error path.");
});

test("normalizeVerdict falls back to legacy `summary` when `walkthrough` is absent", () => {
  const raw = {
    summary: "Legacy single-field summary.",
    findings: [],
    verdict: "approve",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.walkthrough, "Legacy single-field summary.");
  assert.equal(result.verdict, "approve");
});

test("normalizeVerdict demotes request_changes to comment when no blocking findings exist", () => {
  // Model asked for request_changes but only has nit findings. The
  // normalizer enforces the "nits never block" rule.
  const raw = {
    walkthrough: "Walkthrough.",
    findings: [{ path: "a.ts", line: 1, severity: "nit", message: "naming" }],
    architectural_concerns: [],
    verdict: "request_changes",
    verdict_reason: "Model thought this was blocking but it is not.",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.verdict, "comment");
});

test("sanitizeJsonPayload strips markdown fences", () => {
  assert.equal(sanitizeJsonPayload("```json\n{\"a\":1}\n```"), "{\"a\":1}");
  assert.equal(sanitizeJsonPayload("```\n{\"a\":1}\n```"), "{\"a\":1}");
});

test("sanitizeJsonPayload strips trailing commas before } and ]", () => {
  assert.equal(sanitizeJsonPayload("{\"a\":1,\"b\":[1,2,],}"), "{\"a\":1,\"b\":[1,2]}");
});

test("sanitizeJsonPayload strips // line and /* block */ comments", () => {
  assert.equal(
    sanitizeJsonPayload("{\"a\":1 // trailing note\n,\"b\":/* block */ 2}"),
    "{\"a\":1 \n,\"b\": 2}",
  );
});

test("forgivingJsonParse succeeds on clean JSON without touching it", () => {
  const parsed = forgivingJsonParse<{ a: number }>("{\"a\":1}");
  assert.deepEqual(parsed, { a: 1 });
});

test("forgivingJsonParse recovers from markdown fences", () => {
  const parsed = forgivingJsonParse<{ verdict: string }>("```json\n{\"verdict\":\"approve\"}\n```");
  assert.deepEqual(parsed, { verdict: "approve" });
});

test("forgivingJsonParse recovers from trailing commas", () => {
  const parsed = forgivingJsonParse<{ a: number[] }>("{\"a\":[1,2,3,],}");
  assert.deepEqual(parsed, { a: [1, 2, 3] });
});

test("extractFirstJsonObject returns the OUTERMOST top-level object even when it contains nested objects", () => {
  // Reproduces a bug where the extractor returned the LAST balanced
  // block in the text — for the rich verdict schema, that's the LAST
  // element of `findings[]`, not the top-level verdict. The fix:
  // walk forward from the FIRST `{` and let the depth-tracking walker
  // close the outermost block.
  const text = JSON.stringify({
    walkthrough: "Real review walkthrough.",
    architectural_concerns: [
      { severity: "nit", category: "convention", message: "minor convention drift" },
    ],
    findings: [
      { path: "src/a.ts", line: 1, severity: "blocking", message: "first finding" },
      { path: "src/b.ts", line: 2, severity: "nit", message: "last finding" },
    ],
    verdict: "request_changes",
    verdict_reason: "blocking finding present",
  });
  const extracted = extractFirstJsonObject(text);
  assert.ok(extracted);
  const parsed = JSON.parse(extracted!) as { walkthrough: string; findings: unknown[] };
  // Must be the outermost object, not the last finding
  assert.equal(parsed.walkthrough, "Real review walkthrough.");
  assert.equal(parsed.findings.length, 2);
});

test("extractFirstJsonObject ignores prose before and after the JSON", () => {
  const text = "Here is the review:\n{\"walkthrough\":\"x\",\"verdict\":\"approve\"}\n\nLet me know if you need more.";
  const extracted = extractFirstJsonObject(text);
  assert.ok(extracted);
  const parsed = JSON.parse(extracted!) as { walkthrough: string };
  assert.equal(parsed.walkthrough, "x");
});

test("extractFirstJsonObject skips a malformed first attempt and finds a valid later one", () => {
  // First brace-block is malformed (unbalanced, never closes). Walker
  // returns undefined for it; we move to the next `{` and find the
  // valid object.
  const text = "{ this is not really json\n\nbut here is the real one: {\"walkthrough\":\"recovery\",\"verdict\":\"approve\"}";
  const extracted = extractFirstJsonObject(text);
  assert.ok(extracted);
  const parsed = JSON.parse(extracted!) as { walkthrough: string };
  assert.equal(parsed.walkthrough, "recovery");
});

test("normalizeVerdict accepts case-variant severity values", () => {
  const raw = {
    walkthrough: "x",
    findings: [
      { path: "a.ts", line: 1, severity: "BLOCKING", message: "upper" },
      { path: "b.ts", line: 1, severity: "Blocking", message: "title" },
      { path: "c.ts", line: 1, severity: "critical", message: "synonym" },
      { path: "d.ts", line: 1, severity: "NIT", message: "upper nit" },
    ],
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.findings.length, 4);
  assert.equal(result.findings[0]?.severity, "blocking");
  assert.equal(result.findings[1]?.severity, "blocking");
  assert.equal(result.findings[2]?.severity, "blocking"); // "critical" → blocking
  assert.equal(result.findings[3]?.severity, "nit");
});

test("normalizeVerdict accepts string-numeric or L-prefixed line numbers", () => {
  const raw = {
    walkthrough: "x",
    findings: [
      { path: "a.ts", line: "42", severity: "blocking", message: "string number" },
      { path: "b.ts", line: "L107", severity: "nit", message: "L-prefix" },
    ],
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0]?.line, 42);
  assert.equal(result.findings[1]?.line, 107);
});

test("normalizeVerdict accepts verdict synonyms and case variations", () => {
  // "LGTM" → approve
  assert.equal(normalizeVerdict({ walkthrough: "x", verdict: "LGTM", findings: [] }).verdict, "approve");
  // "changes_requested" → request_changes (when blocking findings exist)
  assert.equal(
    normalizeVerdict({
      walkthrough: "x",
      verdict: "CHANGES_REQUESTED",
      findings: [{ path: "a.ts", line: 1, severity: "blocking", message: "bug" }],
    }).verdict,
    "request_changes",
  );
  // "reject" → request_changes
  assert.equal(
    normalizeVerdict({
      walkthrough: "x",
      verdict: "reject",
      findings: [{ path: "a.ts", line: 1, severity: "blocking", message: "bug" }],
    }).verdict,
    "request_changes",
  );
  // "observation" → comment. We keep the model's stated intent even when
  // there are no findings — if the model decided to say "comment" instead
  // of "approve", there's usually a reason (a remark in the walkthrough).
  assert.equal(normalizeVerdict({ walkthrough: "x", verdict: "observation", findings: [] }).verdict, "comment");
});

test("normalizeVerdict accepts alternate field names (file, description, fix)", () => {
  const raw = {
    overview: "Fallback walkthrough field",
    findings: [
      {
        file: "src/foo.ts",           // "file" instead of "path"
        line: 10,
        severity: "blocking",
        description: "wrong",          // "description" instead of "message"
        fix: "if (x) return;",         // "fix" instead of "suggestion"
      },
    ],
    verdict: "request_changes",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.walkthrough, "Fallback walkthrough field");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.path, "src/foo.ts");
  assert.equal(result.findings[0]?.message, "wrong");
  assert.equal(result.findings[0]?.suggestion, "if (x) return;");
});

test("normalizeVerdict drops findings that are missing path, line, severity, or message", () => {
  const raw = {
    walkthrough: "Walkthrough.",
    findings: [
      { path: "a.ts", line: 1, severity: "blocking", message: "valid" },
      { path: "b.ts", severity: "nit", message: "missing line" },            // invalid
      { line: 10, severity: "blocking", message: "missing path" },           // invalid
      { path: "c.ts", line: 5, message: "missing severity" },                 // invalid
      { path: "d.ts", line: 5, severity: "nit" },                             // missing message
    ],
    verdict: "approve",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.path, "a.ts");
});

test("filterFindings drops findings whose path is not in the known-paths set (hallucinated paths)", () => {
  const findings = [
    fakeFinding({ path: "src/known.ts" }),
    fakeFinding({ path: "src/also-known.ts" }),
    fakeFinding({ path: "src/hallucinated.ts" }),
  ];
  const knownPaths = new Set(["src/known.ts", "src/also-known.ts"]);
  const kept = filterFindings(findings, knownPaths);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((f) => knownPaths.has(f.path)));
});

test("filterFindings still works without a knownPaths argument (backward compat)", () => {
  const findings = [fakeFinding({ path: "anything.ts" })];
  const kept = filterFindings(findings);
  assert.equal(kept.length, 1);
});

test("filterFindings drops low-confidence findings", () => {
  const findings = [
    fakeFinding({ path: "a.ts", confidence: 95 }),
    fakeFinding({ path: "b.ts", confidence: 50 }),
    fakeFinding({ path: "c.ts", confidence: 75 }),
    fakeFinding({ path: "d.ts" }), // undefined confidence → treated as 100
  ];
  const kept = filterFindings(findings);
  const paths = kept.map((f) => f.path);
  assert.ok(paths.includes("a.ts"));
  assert.ok(!paths.includes("b.ts"));
  assert.ok(paths.includes("c.ts"));
  assert.ok(paths.includes("d.ts"));
});

test("filterFindings sorts blocking findings ahead of nits and applies the MAX cap", () => {
  const findings: ReviewFinding[] = [
    ...Array.from({ length: 15 }, (_, i) => fakeFinding({ path: `nit-${i}.ts`, line: i + 1, severity: "nit" })),
    ...Array.from({ length: 10 }, (_, i) => fakeFinding({ path: `blocking-${i}.ts`, line: i + 1, severity: "blocking" })),
  ];
  const kept = filterFindings(findings);
  assert.equal(kept.length, 20); // MAX cap
  // All 10 blocking findings must be kept (ordered first)
  const blockingKept = kept.filter((f) => f.severity === "blocking");
  assert.equal(blockingKept.length, 10);
  // 10 of 15 nits fit in the remaining slots
  const nitsKept = kept.filter((f) => f.severity === "nit");
  assert.equal(nitsKept.length, 10);
});

test("resolveEvent enforces 'nits never block'", () => {
  // No findings at all → approve
  assert.equal(resolveEvent(fakeVerdict(), []), "APPROVE");

  // Only nits → comment (never request_changes)
  assert.equal(
    resolveEvent(fakeVerdict(), [fakeFinding({ severity: "nit" })]),
    "COMMENT",
  );

  // At least one blocking → request_changes
  assert.equal(
    resolveEvent(fakeVerdict(), [fakeFinding({ severity: "blocking" })]),
    "REQUEST_CHANGES",
  );

  // Blocking architectural concern, no line findings → request_changes
  assert.equal(
    resolveEvent(
      fakeVerdict({
        architectural_concerns: [{ severity: "blocking", category: "intent", message: "wrong feature" }],
      }),
      [],
    ),
    "REQUEST_CHANGES",
  );

  // Only nit-level architectural concerns → comment
  assert.equal(
    resolveEvent(
      fakeVerdict({
        architectural_concerns: [{ severity: "nit", category: "convention", message: "naming drift" }],
      }),
      [],
    ),
    "COMMENT",
  );
});

test("buildReviewBody includes walkthrough, architectural concerns, and verdict rationale", () => {
  const body = buildReviewBody({
    verdict: fakeVerdict({
      walkthrough: "This PR refactors X.",
      architectural_concerns: [
        { severity: "blocking", category: "regression", message: "Breaks the existing Y API." },
        { severity: "nit", category: "convention", message: "Inconsistent with Z style." },
      ],
      verdict_reason: "One blocking architectural concern.",
    }),
    event: "REQUEST_CHANGES",
  });
  assert.match(body, /This PR refactors X\./);
  assert.match(body, /## Architectural concerns/);
  assert.match(body, /🚨 \*\*\[regression\]\*\* Breaks the existing Y API\./);
  assert.match(body, /💡 \*\*\[convention\]\*\* Inconsistent with Z style\./);
  assert.match(body, /🛑 Request changes.*One blocking architectural concern\./);
});

test("buildReviewBody omits architectural section when empty", () => {
  const body = buildReviewBody({
    verdict: fakeVerdict({ walkthrough: "Clean PR.", verdict_reason: "No issues." }),
    event: "APPROVE",
  });
  assert.doesNotMatch(body, /## Architectural concerns/);
  assert.match(body, /✅ Approve.*No issues\./);
});

test("buildInlineCommentBody includes a suggestion block for ≤6-line fixes", () => {
  const body = buildInlineCommentBody(fakeFinding({
    severity: "blocking",
    message: "Missing null check",
    suggestion: "if (user) {\n  return user.name;\n}\nreturn 'unknown';",
  }));
  assert.match(body, /🚨 Missing null check/);
  assert.match(body, /```suggestion[\s\S]*```/);
});

test("buildInlineCommentBody drops the suggestion block when fix exceeds 6 lines", () => {
  const longSuggestion = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
  const body = buildInlineCommentBody(fakeFinding({
    severity: "nit",
    message: "Refactor this whole block",
    suggestion: longSuggestion,
  }));
  assert.match(body, /💡 Refactor this whole block/);
  assert.doesNotMatch(body, /```suggestion/);
});

test("classifyPublicationDisposition cancels draft or closed PRs", () => {
  assert.equal(classifyPublicationDisposition({
    state: "OPEN",
    isDraft: true,
    headSha: "same-head",
  }, "same-head").action, "cancel");

  assert.equal(classifyPublicationDisposition({
    state: "CLOSED",
    isDraft: false,
    headSha: "same-head",
  }, "same-head").action, "cancel");
});
