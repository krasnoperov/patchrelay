import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptComposerDisplayLines, measurePromptComposerRows } from "../src/cli/watch/prompt-layout.ts";

test("buildPromptComposerDisplayLines includes prefixed prompt lines and a hint row", () => {
  const lines = buildPromptComposerDisplayLines("first line\nsecond line", 5);
  assert.deepEqual(lines, [
    "prompt> first| line",
    "        second line",
    "Enter: send  Ctrl-N: newline  Up/Down: history  Esc: cancel",
  ]);
});

test("measurePromptComposerRows accounts for wrapped prompt and hint rows", () => {
  const rows = measurePromptComposerRows("this is a long prompt line that should wrap", 10, 16);
  assert.ok(rows > 2);
});
