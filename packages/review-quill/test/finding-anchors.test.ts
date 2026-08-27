import assert from "node:assert/strict";
import test from "node:test";
import { changedNewLinesFromPatch, nearestChangedLine } from "../src/finding-anchors.ts";

test("changedNewLinesFromPatch tracks only additions across diff hunks", () => {
  const patch = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -8,3 +8,4 @@
 context
-old
+new
+added
 context
@@ -30 +31 @@
-before
+after`;

  assert.deepEqual([...changedNewLinesFromPatch(patch)], [9, 10, 31]);
});

test("nearestChangedLine corrects nearby context anchors without jumping hunks", () => {
  const changed = new Set([20, 21, 80]);
  assert.equal(nearestChangedLine(changed, 18), 20);
  assert.equal(nearestChangedLine(changed, 21), 21);
  assert.equal(nearestChangedLine(changed, 40), undefined);
});
