import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveGitHubAppCredentials,
  resolveGitHubAuthConfig,
} from "../src/github-auth.ts";
import { resolveGitHubCommandEnv } from "../src/exec.ts";

test("resolveGitHubAuthConfig resolves GitHub App credentials when configured", () => {
  const auth = resolveGitHubAuthConfig({
    MERGE_STEWARD_GITHUB_APP_ID: "123456",
    MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  });

  assert.equal(auth.mode, "app");
  if (auth.mode === "app") {
    assert.equal(auth.credentials.appId, "123456");
  }
});

test("resolveGitHubAuthConfig returns none without GitHub App credentials", () => {
  assert.deepEqual(resolveGitHubAuthConfig({}), { mode: "none" });
});

test("resolveGitHubAppCredentials captures the optional installation id", () => {
  const credentials = resolveGitHubAppCredentials({
    MERGE_STEWARD_GITHUB_APP_ID: "123456",
    MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID: "654321",
    MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  });

  assert.equal(credentials?.appId, "123456");
  assert.equal(credentials?.installationId, "654321");
});

test("resolveGitHubCommandEnv injects runtime tokens into gh commands", () => {
  const env = resolveGitHubCommandEnv(
    "gh",
    {},
    {
      githubRepoFullName: "owner/repo",
      runtimeAuthProvider: {
        currentTokenForRepo(repoFullName?: string) {
          return repoFullName === "owner/repo" ? "runtime-token" : undefined;
        },
      },
    },
  );

  assert.equal(env.GH_TOKEN, "runtime-token");
  assert.equal(env.GITHUB_TOKEN, "runtime-token");
});

test("resolveGitHubCommandEnv injects GitHub auth headers for git commands from runtime auth", () => {
  const env = resolveGitHubCommandEnv("git", {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "/tmp/repo",
  }, {
    githubRepoFullName: "owner/repo",
    runtimeAuthProvider: {
      currentTokenForRepo(repoFullName?: string) {
        return repoFullName === "owner/repo" ? "runtime-token" : undefined;
      },
    },
  });

  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_CONFIG_KEY_1, "http.https://github.com/.extraheader");
  assert.match(env.GIT_CONFIG_VALUE_1 ?? "", /^AUTHORIZATION: basic /);
  assert.equal(env.GH_TOKEN, "runtime-token");
  assert.equal(env.GITHUB_TOKEN, "runtime-token");
});
