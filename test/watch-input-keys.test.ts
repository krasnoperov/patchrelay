import assert from "node:assert/strict";
import test from "node:test";
import { isPromptBackspaceKey, isPromptDeleteKey } from "../src/cli/watch/input-keys.ts";

test("isPromptBackspaceKey accepts common terminal backspace variants", () => {
  assert.equal(isPromptBackspaceKey("", { backspace: true }), true);
  assert.equal(isPromptBackspaceKey("\u0008", {}), true);
  assert.equal(isPromptBackspaceKey("\u007f", {}), true);
  assert.equal(isPromptBackspaceKey("h", { ctrl: true }), true);
  assert.equal(isPromptBackspaceKey("x", {}), false);
});

test("isPromptDeleteKey accepts the terminal delete escape sequence", () => {
  assert.equal(isPromptDeleteKey("", { delete: true }), true);
  assert.equal(isPromptDeleteKey("\u001b[3~", {}), true);
  assert.equal(isPromptDeleteKey("\u007f", {}), false);
});
