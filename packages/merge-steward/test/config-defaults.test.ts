import assert from "node:assert/strict";
import test from "node:test";
import { stewardConfigSchema } from "../src/config.ts";

test("omitted speculative depth defaults to three", () => {
  const config = stewardConfigSchema.parse({
    repoId: "app",
    repoFullName: "owner/app",
    clonePath: "/tmp/app",
    database: { path: "/tmp/app.sqlite" },
  });
  assert.equal(config.speculativeDepth, 3);
});
