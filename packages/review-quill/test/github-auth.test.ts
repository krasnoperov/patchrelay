import assert from "node:assert/strict";
import test from "node:test";
import { resolveGitHubAuthConfig } from "../src/github-auth.ts";

test("resolveGitHubAuthConfig resolves GitHub App credentials", () => {
  const auth = resolveGitHubAuthConfig({
    REVIEW_QUILL_GITHUB_APP_ID: "123",
    REVIEW_QUILL_GITHUB_APP_PRIVATE_KEY: "pem-value",
  });

  assert.equal(auth.mode, "app");
  if (auth.mode !== "app") return;
  assert.equal(auth.credentials.appId, "123");
  assert.equal(auth.credentials.privateKey, "pem-value");
});
