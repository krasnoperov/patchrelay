import assert from "node:assert/strict";
import test from "node:test";
import { candidateChainLabel, ciStatusIcon } from "../src/watch/format.ts";

test("ciStatusIcon maps queue and post-merge states", () => {
  assert.deepEqual(ciStatusIcon({ status: "merged", ciRunId: null, postMergeStatus: "pass" }), { icon: "\u2713", color: "green" });
  assert.deepEqual(ciStatusIcon({ status: "validating", ciRunId: "ci-1" }), { icon: "\u25cf", color: "cyan" });
  assert.deepEqual(ciStatusIcon({ status: "validating", ciRunId: null }), { icon: "\u25cb", color: "gray" });
  assert.deepEqual(ciStatusIcon({ status: "evicted", ciRunId: null }), { icon: "\u2717", color: "red" });
});

test("candidateChainLabel describes resolved and pending candidates", () => {
  const entries = [{ id: "qe-1", prNumber: 110, candidateRef: "mq-spec-1" }];
  assert.equal(candidateChainLabel({ candidateRef: "mq-spec-1", candidateBasedOn: null, candidateSha: "abc1234567" }, []), "abc1234 \u2190 main");
  assert.equal(candidateChainLabel({ candidateRef: "mq-spec-2", candidateBasedOn: "qe-1", candidateSha: "def5678901" }, entries), "def5678 \u2190 #110");
  assert.equal(candidateChainLabel({ candidateRef: null, candidateBasedOn: null, candidateSha: null }, []), "no candidate yet");
});
