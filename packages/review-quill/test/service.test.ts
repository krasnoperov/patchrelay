import assert from "node:assert/strict";
import test from "node:test";
import { ReviewQuillService } from "../src/service.ts";
import { normalizeVerdict } from "../src/review-runner.ts";
import { extractFirstJsonObject, forgivingJsonParse, sanitizeJsonPayload } from "../src/utils.ts";

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

test("normalizeVerdict demotes request_changes to approve when no blocking findings exist", () => {
  // Model asked for request_changes but only has nit findings. The
  // normalizer enforces the binary merge-gate rule.
  const raw = {
    walkthrough: "Walkthrough.",
    findings: [{ path: "a.ts", line: 1, severity: "nit", message: "naming" }],
    architectural_concerns: [],
    verdict: "request_changes",
    verdict_reason: "Model thought this was blocking but it is not.",
  };
  const result = normalizeVerdict(raw);
  assert.equal(result.verdict, "approve");
});

test("getWatchSnapshot counts only the latest attempt per pull request", () => {
  const service = new ReviewQuillService(
    {
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: ":memory:", wal: true },
      logging: { level: "info" },
      reconciliation: {
        pollIntervalMs: 1_000,
        heartbeatIntervalMs: 1_000,
        staleQueuedAfterMs: 60_000,
        staleRunningAfterMs: 60_000,
      },
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      prompting: { replaceSections: {} },
      repositories: [
        {
          repoId: "ballony-i-nasosy",
          repoFullName: "krasnoperov/ballony-i-nasosy",
          baseBranch: "main",
          requiredChecks: [],
          excludeBranches: [],
          reviewDocs: [],
          diffIgnore: [],
          diffSummarizeOnly: [],
          patchBodyBudgetTokens: 5_000,
        },
      ],
      secretSources: {},
    } as never,
    {
      listAttempts: () => [
        {
          id: 1,
          repoFullName: "krasnoperov/ballony-i-nasosy",
          prNumber: 55,
          headSha: "old",
          status: "failed",
          conclusion: "error",
          createdAt: "2026-04-09T20:00:00.000Z",
          updatedAt: "2026-04-09T20:01:00.000Z",
        },
        {
          id: 2,
          repoFullName: "krasnoperov/ballony-i-nasosy",
          prNumber: 55,
          headSha: "new",
          status: "completed",
          conclusion: "approved",
          createdAt: "2026-04-09T20:02:00.000Z",
          updatedAt: "2026-04-09T20:03:00.000Z",
        },
      ],
      listWebhooks: () => [],
    } as never,
    {} as never,
    {} as never,
    { child: () => ({}) } as never,
  );

  const snapshot = service.getWatchSnapshot();
  assert.equal(snapshot.summary.totalAttempts, 1);
  assert.equal(snapshot.summary.failedAttempts, 0);
  assert.equal(snapshot.summary.completedAttempts, 1);
  assert.equal(snapshot.repos[0]?.failedAttempts, 0);
  assert.equal(snapshot.repos[0]?.completedAttempts, 1);
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
    verdict: "request_changes",
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
    verdict: "request_changes",
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
  // Non-binary verdicts are rejected so the corrective retry can demand
  // an explicit deploy decision.
  assert.throws(
    () => normalizeVerdict({ walkthrough: "x", verdict: "observation", findings: [] }),
    /explicit binary verdict/i,
  );
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
