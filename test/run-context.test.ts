import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRunContext,
  parseRunContextOrWarn,
  parseRunContextValue,
  RunContextParseError,
  serializeRunContext,
  tryParseRunContextValue,
  type RunContext,
} from "../src/run-context.ts";

test("parseRunContext returns undefined for null, undefined, and empty input", () => {
  assert.equal(parseRunContext(null), undefined);
  assert.equal(parseRunContext(undefined), undefined);
  assert.equal(parseRunContext(""), undefined);
  assert.equal(parseRunContext("   "), undefined);
});

test("parseRunContext parses a typical branch-upkeep context", () => {
  const context = parseRunContext(JSON.stringify({
    branchUpkeepRequired: true,
    reviewFixMode: "branch_upkeep",
    workflowReason: "branch_upkeep",
    promptContext: "Update onto latest main.",
    mergeStateStatus: "DIRTY",
    failingHeadSha: "abc123",
    baseBranch: "main",
  }));
  assert.equal(context?.branchUpkeepRequired, true);
  assert.equal(context?.reviewFixMode, "branch_upkeep");
  assert.equal(context?.mergeStateStatus, "DIRTY");
  assert.equal(context?.baseBranch, "main");
});

test("parseRunContext parses a CI-repair failure context with nested snapshot", () => {
  const context = parseRunContext(JSON.stringify({
    source: "branch_ci",
    failureSignature: "branch_ci::abc::verify::test",
    failureHeadSha: "abc",
    checkName: "verify",
    annotations: ["AssertionError: expected 1 to equal 2"],
    ciSnapshot: {
      headSha: "abc",
      gateCheckName: "verify",
      gateCheckStatus: "failure",
      failedChecks: [{ name: "verify", summary: "boom" }],
    },
  }));
  assert.equal(context?.failureSignature, "branch_ci::abc::verify::test");
  assert.deepEqual(context?.annotations, ["AssertionError: expected 1 to equal 2"]);
  assert.equal(context?.ciSnapshot?.gateCheckStatus, "failure");
  assert.equal(context?.ciSnapshot?.failedChecks?.[0]?.name, "verify");
});

test("parseRunContext accepts legacy shapes with fields no current code writes", () => {
  // Older versions persisted contexts with fields like mergeQueueContext and
  // userComment, plus producer-specific extra keys. Those rows must still parse.
  const context = parseRunContext(JSON.stringify({
    userComment: "please fix",
    mergeQueueContext: {
      baseBranch: "main",
      conflictingFiles: ["src/a.ts"],
      operatorHints: ["rebase first"],
    },
    runType: "main_repair", // removed run type — must survive as a plain string
    someFieldFromAnOlderVersion: { nested: true },
  }));
  assert.equal(context?.userComment, "please fix");
  assert.deepEqual(context?.mergeQueueContext?.conflictingFiles, ["src/a.ts"]);
  assert.equal(context?.runType, "main_repair");
  // Unknown top-level keys pass through at runtime (loose object).
  assert.deepEqual((context as Record<string, unknown>).someFieldFromAnOlderVersion, { nested: true });
});

test("parseRunContext throws RunContextParseError on malformed JSON", () => {
  assert.throws(() => parseRunContext("{not json"), RunContextParseError);
  assert.throws(() => parseRunContext("{not json"), /Malformed run context JSON/);
});

test("parseRunContext throws on non-object JSON", () => {
  assert.throws(() => parseRunContext("[1,2,3]"), RunContextParseError);
  assert.throws(() => parseRunContext("\"a string\""), RunContextParseError);
});

test("parseRunContext fails loudly on mistyped known fields", () => {
  assert.throws(
    () => parseRunContext(JSON.stringify({ branchUpkeepRequired: "yes" })),
    RunContextParseError,
  );
  assert.throws(
    () => parseRunContext(JSON.stringify({ reviewFixMode: "something_else" })),
    RunContextParseError,
  );
  assert.throws(
    () => parseRunContext(JSON.stringify({ followUpCount: "three" })),
    /followUpCount/,
  );
});

test("parseRunContextOrWarn degrades to undefined and reports the failure", () => {
  const warnings: string[] = [];
  const context = parseRunContextOrWarn("{broken", (message) => warnings.push(message));
  assert.equal(context, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Malformed run context JSON/);

  const valid = parseRunContextOrWarn(JSON.stringify({ workflowReason: "delegated" }), () => {
    throw new Error("should not warn on valid input");
  });
  assert.equal(valid?.workflowReason, "delegated");
});

test("serializeRunContext round-trips through parseRunContext", () => {
  const original: RunContext = {
    workflowReason: "settled_red_ci",
    failureSignature: "branch_ci::abc::verify::step",
    failureHeadSha: "abc",
    followUps: [{ type: "direct_reply", text: "hi", author: "alv" }],
    followUpMode: true,
    followUpCount: 1,
    requiresFreshHead: true,
  };
  const json = serializeRunContext(original);
  const parsed = parseRunContext(json);
  assert.deepEqual(parsed, original);
});

test("serializeRunContext rejects shapes the parser would reject", () => {
  assert.throws(
    () => serializeRunContext({ previousPrNumber: "42" } as unknown as RunContext),
    RunContextParseError,
  );
});

test("parseRunContextValue validates already-parsed values", () => {
  assert.equal(parseRunContextValue({ headSha: "abc" }).headSha, "abc");
  assert.throws(() => parseRunContextValue("not an object"), RunContextParseError);
  assert.throws(() => parseRunContextValue({ headSha: 42 }), RunContextParseError);
});

test("tryParseRunContextValue returns undefined instead of throwing", () => {
  assert.equal(tryParseRunContextValue({ headSha: 42 }), undefined);
  assert.equal(tryParseRunContextValue({ headSha: "abc" })?.headSha, "abc");
});

test("nested objects strip unknown keys instead of passing them through", () => {
  const context = parseRunContext(JSON.stringify({
    ciSnapshot: { gateCheckName: "verify", someUnknownNestedKey: 1 },
  }));
  assert.equal(context?.ciSnapshot?.gateCheckName, "verify");
  assert.equal("someUnknownNestedKey" in (context?.ciSnapshot ?? {}), false);
});
