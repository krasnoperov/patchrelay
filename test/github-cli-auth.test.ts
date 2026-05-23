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
  const env = buildGitHubCliAuthEnv({ ghConfigDir: "/data/gh-bot", ghBin: "/usr/bin/gh", identity: { name: "patchrelay[bot]", email: "1+patchrelay[bot]@users.noreply.github.com" } });
  assert.equal(env.GH_CONFIG_DIR, "/data/gh-bot");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  // git delegates github.com credentials to gh (an empty entry clears any inherited helper first)
  assert.equal(env.GIT_CONFIG_KEY_0, "credential.https://github.com.helper");
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  assert.equal(env.GIT_CONFIG_KEY_1, "credential.https://github.com.helper");
  assert.equal(env.GIT_CONFIG_VALUE_1, "!/usr/bin/gh auth git-credential");
  assert.equal(env.GIT_AUTHOR_NAME, "patchrelay[bot]");
  assert.equal(env.GIT_COMMITTER_EMAIL, "1+patchrelay[bot]@users.noreply.github.com");
});

test("buildAgentChildEnv strips GH_TOKEN/GITHUB_TOKEN so the long-lived child uses GH_CONFIG_DIR", () => {
  const parent: NodeJS.ProcessEnv = { GH_TOKEN: "stale", GITHUB_TOKEN: "stale", GH_CONFIG_DIR: "/data/gh-bot", PATH: "/usr/bin" };
  const child = buildAgentChildEnv(parent);
  assert.equal(child.GH_TOKEN, undefined);
  assert.equal(child.GITHUB_TOKEN, undefined);
  // the rotated config dir and the rest of the env are preserved
  assert.equal(child.GH_CONFIG_DIR, "/data/gh-bot");
  assert.equal(child.PATH, "/usr/bin");
  // does not mutate the parent (daemon keeps its fresh token)
  assert.equal(parent.GH_TOKEN, "stale");
});

test("writeGhHostsToken writes a 0600 hosts.yml gh can read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghcfg-"));
  try {
    const ghConfigDir = getGhConfigDir(dir);
    await writeGhHostsToken(ghConfigDir, "ghs_exampletoken", "patchrelay[bot]");
    const hostsPath = path.join(ghConfigDir, "hosts.yml");
    const contents = readFileSync(hostsPath, "utf8");
    assert.match(contents, /github\.com:/);
    assert.match(contents, /oauth_token: ghs_exampletoken/);
    assert.match(contents, /user: patchrelay\[bot\]/);
    assert.match(contents, /git_protocol: https/);
    assert.equal(statSync(hostsPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// End-to-end: git, given only the injected env, must obtain the rotated token via gh.
// Skipped where the gh CLI is unavailable (e.g. minimal CI images).
const ghBin = resolveGhBin();
const ghAvailable = path.isAbsolute(ghBin) && existsSync(ghBin);
test("git reads the rotated token from gh via the injected credential helper", { skip: ghAvailable ? false : "gh CLI not installed" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ghcfg-"));
  try {
    const ghConfigDir = getGhConfigDir(dir);
    await writeGhHostsToken(ghConfigDir, "ghs_rotatedtoken123", "patchrelay[bot]");
    const daemonEnv: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
    applyGitHubCliAuthEnv(daemonEnv, { ghConfigDir, ghBin });
    // The agent runs with the child env (token vars stripped) and must still resolve the
    // rotated token via GH_CONFIG_DIR.
    const childEnv = buildAgentChildEnv(daemonEnv);
    const stdout = await runGitCredentialFill(childEnv, "protocol=https\nhost=github.com\n\n");
    assert.match(stdout, /username=patchrelay\[bot\]/);
    assert.match(stdout, /password=ghs_rotatedtoken123/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
