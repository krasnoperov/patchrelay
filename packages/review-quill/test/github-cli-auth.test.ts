import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyGitHubCliAuthEnv,
  buildAgentChildEnv,
  buildGitHubCliAuthEnv,
  getGhConfigDir,
  resolveGhBin,
  writeGhHostsToken,
} from "../src/github-cli-auth.ts";

function runGitCredentialFill(env: NodeJS.ProcessEnv, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential", "fill"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git credential fill exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

test("buildGitHubCliAuthEnv points gh at the config dir and routes git through gh", () => {
  const env = buildGitHubCliAuthEnv({ ghConfigDir: "/data/gh-bot", ghBin: "/usr/bin/gh", identity: { name: "review-quill[bot]", email: "1+review-quill[bot]@users.noreply.github.com" } });
  assert.equal(env.GH_CONFIG_DIR, "/data/gh-bot");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CONFIG_KEY_0, "credential.https://github.com.helper");
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  assert.equal(env.GIT_CONFIG_KEY_1, "credential.https://github.com.helper");
  assert.equal(env.GIT_CONFIG_VALUE_1, "!/usr/bin/gh auth git-credential");
  assert.equal(env.GIT_AUTHOR_NAME, "review-quill[bot]");
  assert.equal(env.GIT_COMMITTER_EMAIL, "1+review-quill[bot]@users.noreply.github.com");
});

test("buildAgentChildEnv strips GH_TOKEN/GITHUB_TOKEN so the agent can't use the operator's token", () => {
  const parent: NodeJS.ProcessEnv = { GH_TOKEN: "operator", GITHUB_TOKEN: "operator", GH_CONFIG_DIR: "/data/gh-bot", PATH: "/usr/bin" };
  const child = buildAgentChildEnv(parent);
  assert.equal(child.GH_TOKEN, undefined);
  assert.equal(child.GITHUB_TOKEN, undefined);
  assert.equal(child.GH_CONFIG_DIR, "/data/gh-bot");
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(parent.GH_TOKEN, "operator"); // does not mutate the parent
});

test("writeGhHostsToken writes a 0600 hosts.yml gh can read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rq-ghcfg-"));
  try {
    const ghConfigDir = getGhConfigDir(dir);
    await writeGhHostsToken(ghConfigDir, "ghs_exampletoken", "review-quill[bot]");
    const hostsPath = path.join(ghConfigDir, "hosts.yml");
    const contents = readFileSync(hostsPath, "utf8");
    assert.match(contents, /github\.com:/);
    assert.match(contents, /oauth_token: ghs_exampletoken/);
    assert.match(contents, /user: review-quill\[bot\]/);
    assert.match(contents, /git_protocol: https/);
    assert.equal(statSync(hostsPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// End-to-end: the review agent's git, given only the injected env, obtains the rotated
// bot token via gh — never the operator's credentials. Skipped where gh is unavailable.
const ghBin = resolveGhBin();
const ghAvailable = path.isAbsolute(ghBin) && existsSync(ghBin);
test("agent git resolves the App token from gh, with operator token vars stripped", { skip: ghAvailable ? false : "gh CLI not installed" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rq-ghcfg-"));
  try {
    const ghConfigDir = getGhConfigDir(dir);
    await writeGhHostsToken(ghConfigDir, "ghs_botrotated456", "review-quill[bot]");
    // Simulate the daemon process env (carries an operator token) then apply bot auth.
    const daemonEnv: NodeJS.ProcessEnv = { ...process.env, HOME: dir, GH_TOKEN: "ghs_operatortoken" };
    applyGitHubCliAuthEnv(daemonEnv, { ghConfigDir, ghBin });
    const childEnv = buildAgentChildEnv(daemonEnv);
    const stdout = await runGitCredentialFill(childEnv, "protocol=https\nhost=github.com\n\n");
    assert.match(stdout, /username=review-quill\[bot\]/);
    assert.match(stdout, /password=ghs_botrotated456/);
    assert.doesNotMatch(stdout, /ghs_operatortoken/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
