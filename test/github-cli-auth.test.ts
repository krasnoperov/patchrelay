import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  assert.equal(env.GIT_CONFIG_COUNT, "4");
  assert.equal(env.GIT_CONFIG_KEY_2, "commit.gpgSign");
  assert.equal(env.GIT_CONFIG_VALUE_2, "false");
  assert.equal(env.GIT_CONFIG_KEY_3, "tag.gpgSign");
  assert.equal(env.GIT_CONFIG_VALUE_3, "false");
  assert.equal(env.GIT_AUTHOR_NAME, "patchrelay[bot]");
  assert.equal(env.GIT_COMMITTER_EMAIL, "1+patchrelay[bot]@users.noreply.github.com");
  assert.equal(env.GNUPGHOME, undefined);
  assert.equal(env.GIT_CONFIG_KEY_4, undefined);
});

test("buildGitHubCliAuthEnv preserves App authorship and configures the exact signer", () => {
  const env = buildGitHubCliAuthEnv({
    ghConfigDir: "/data/gh-bot",
    ghBin: "/usr/bin/gh",
    identity: { name: "patchrelay[bot]", email: "1+patchrelay[bot]@users.noreply.github.com" },
    signing: {
      gpgHome: "/data/gpg-bot",
      signingKey: "0123456789ABCDEF0123456789ABCDEF01234567",
      committerName: "PatchRelay Bot",
      committerEmail: "patchrelay-bot@example.com",
    },
  });

  assert.equal(env.GIT_AUTHOR_NAME, "patchrelay[bot]");
  assert.equal(env.GIT_AUTHOR_EMAIL, "1+patchrelay[bot]@users.noreply.github.com");
  assert.equal(env.GIT_COMMITTER_NAME, "PatchRelay Bot");
  assert.equal(env.GIT_COMMITTER_EMAIL, "patchrelay-bot@example.com");
  assert.equal(env.GNUPGHOME, "/data/gpg-bot");
  assert.equal(env.GIT_CONFIG_COUNT, "7");
  assert.deepEqual(
    Array.from({ length: 7 }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]),
    [
      ["credential.https://github.com.helper", ""],
      ["credential.https://github.com.helper", "!/usr/bin/gh auth git-credential"],
      ["gpg.format", "openpgp"],
      ["gpg.program", "/usr/bin/gpg"],
      ["user.signingKey", "0123456789ABCDEF0123456789ABCDEF01234567!"],
      ["commit.gpgSign", "true"],
      ["tag.gpgSign", "true"],
    ],
  );
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(Object.keys(env).some((key) => /passphrase/i.test(key)), false);
  const child = buildAgentChildEnv({ ...env, GH_TOKEN: "short-lived", GITHUB_TOKEN: "short-lived" });
  assert.equal(child.GH_TOKEN, undefined);
  assert.equal(child.GITHUB_TOKEN, undefined);
  assert.equal(child.GNUPGHOME, "/data/gpg-bot");
  assert.equal(child.GIT_CONFIG_VALUE_4, "0123456789ABCDEF0123456789ABCDEF01234567!");
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
const gpgAvailable = existsSync("/usr/bin/gpg");
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
    await writeGhHostsToken(ghConfigDir, "ghs_refreshedtoken456", "patchrelay[bot]");
    const refreshed = await runGitCredentialFill(childEnv, "protocol=https\nhost=github.com\n\n");
    assert.match(refreshed, /password=ghs_refreshedtoken456/);
    assert.doesNotMatch(refreshed, /ghs_rotatedtoken123/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsigned App mode overrides globally enabled signing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "patchrelay-unsigned-git-"));
  try {
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    const globalConfig = path.join(dir, "global.gitconfig");
    writeFileSync(globalConfig, "[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = /bin/false\n[user]\n\tsigningKey = DEADBEEF\n");
    const env = {
      ...process.env,
      HOME: dir,
      GIT_CONFIG_GLOBAL: globalConfig,
      ...buildGitHubCliAuthEnv({
        ghConfigDir: path.join(dir, "gh-bot"),
        ghBin: "/usr/bin/gh",
        identity: { name: "patchrelay[bot]", email: "1+patchrelay[bot]@users.noreply.github.com" },
      }),
    };
    assert.equal(spawnSync("git", ["init", "-q", repo], { env }).status, 0);
    assert.equal(spawnSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "unsigned"], { env }).status, 0);
    assert.equal(spawnSync("git", ["-C", repo, "tag", "unsigned-tag"], { env }).status, 0);
    const commit = spawnSync("git", ["-C", repo, "cat-file", "commit", "HEAD"], { env, encoding: "utf8" });
    assert.equal(commit.status, 0);
    assert.doesNotMatch(commit.stdout, /^gpgsig /m);
    const tagType = spawnSync("git", ["-C", repo, "cat-file", "-t", "refs/tags/unsigned-tag"], { env, encoding: "utf8" });
    assert.equal(tagType.stdout.trim(), "commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configured signer produces verifiable commits and tags with separate identities", { skip: gpgAvailable ? false : "/usr/bin/gpg not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "patchrelay-signing-success-"));
  try {
    const repo = path.join(dir, "repo");
    const gpgHome = path.join(dir, "gnupg");
    mkdirSync(repo);
    mkdirSync(gpgHome, { mode: 0o700 });
    const generated = spawnSync("/usr/bin/gpg", ["--batch", "--homedir", gpgHome, "--generate-key"], {
      input: [
        "Key-Type: EDDSA",
        "Key-Curve: Ed25519",
        "Key-Usage: cert",
        "Subkey-Type: EDDSA",
        "Subkey-Curve: Ed25519",
        "Subkey-Usage: sign",
        "Name-Real: PatchRelay Integration Signer",
        "Name-Email: signer@example.com",
        "Expire-Date: 1d",
        "%no-protection",
        "%commit",
        "",
      ].join("\n"),
      encoding: "utf8",
    });
    assert.equal(generated.status, 0, generated.stderr);
    const listed = spawnSync("/usr/bin/gpg", ["--batch", "--homedir", gpgHome, "--with-colons", "--list-secret-keys"], {
      encoding: "utf8",
    });
    assert.equal(listed.status, 0, listed.stderr);
    const fingerprints = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.split(":"))
      .filter((fields) => fields[0] === "fpr")
      .map((fields) => fields[9])
      .filter((fingerprint): fingerprint is string => Boolean(fingerprint));
    const signingKey = fingerprints.at(-1);
    assert.match(signingKey ?? "", /^[0-9A-F]{40}$/);

    const env = {
      ...process.env,
      HOME: dir,
      ...buildGitHubCliAuthEnv({
        ghConfigDir: path.join(dir, "gh-bot"),
        ghBin: "/usr/bin/gh",
        identity: { name: "patchrelay[bot]", email: "1+patchrelay[bot]@users.noreply.github.com" },
        signing: {
          gpgHome,
          signingKey: signingKey!,
          committerName: "PatchRelay Bot",
          committerEmail: "patchrelay-bot@example.com",
        },
      }),
    };
    assert.equal(spawnSync("git", ["init", "-q", repo], { env }).status, 0);
    assert.equal(spawnSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "signed"], { env }).status, 0);
    assert.equal(spawnSync("git", ["-C", repo, "verify-commit", "HEAD"], { env }).status, 0);
    assert.equal(spawnSync("git", ["-C", repo, "tag", "-m", "signed tag", "signed-tag"], { env }).status, 0);
    assert.equal(spawnSync("git", ["-C", repo, "verify-tag", "signed-tag"], { env }).status, 0);

    const identities = spawnSync("git", ["-C", repo, "show", "-s", "--format=%an%n%ae%n%cn%n%ce", "HEAD"], {
      env,
      encoding: "utf8",
    });
    assert.equal(identities.status, 0);
    assert.deepEqual(identities.stdout.trim().split(/\r?\n/), [
      "patchrelay[bot]",
      "1+patchrelay[bot]@users.noreply.github.com",
      "PatchRelay Bot",
      "patchrelay-bot@example.com",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configured unavailable signer fails without creating an unsigned commit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "patchrelay-signed-git-"));
  try {
    const repo = path.join(dir, "repo");
    const gpgHome = path.join(dir, "gnupg");
    mkdirSync(repo);
    mkdirSync(gpgHome, { mode: 0o700 });
    const env = {
      ...process.env,
      HOME: dir,
      ...buildGitHubCliAuthEnv({
        ghConfigDir: path.join(dir, "gh-bot"),
        ghBin: "/usr/bin/gh",
        identity: { name: "patchrelay[bot]", email: "1+patchrelay[bot]@users.noreply.github.com" },
        signing: {
          gpgHome,
          signingKey: "0123456789ABCDEF0123456789ABCDEF01234567",
          committerName: "PatchRelay Bot",
          committerEmail: "patchrelay-bot@example.com",
        },
      }),
    };
    assert.equal(spawnSync("git", ["init", "-q", repo], { env }).status, 0);
    const commit = spawnSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "must fail"], {
      env,
      encoding: "utf8",
    });
    assert.notEqual(commit.status, 0);
    assert.match(commit.stderr, /failed to sign|signing failed|No secret key/i);
    assert.notEqual(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "HEAD"], { env }).status, 0);

    const unsignedSeedEnv = {
      ...process.env,
      HOME: dir,
      ...buildGitHubCliAuthEnv({
        ghConfigDir: path.join(dir, "gh-bot"),
        ghBin: "/usr/bin/gh",
        identity: { name: "patchrelay[bot]", email: "1+patchrelay[bot]@users.noreply.github.com" },
      }),
    };
    assert.equal(spawnSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "seed"], { env: unsignedSeedEnv }).status, 0);
    const tag = spawnSync("git", ["-C", repo, "tag", "-m", "must fail", "must-fail"], { env, encoding: "utf8" });
    assert.notEqual(tag.status, 0);
    assert.match(tag.stderr, /failed to sign|signing failed|No secret key/i);
    assert.notEqual(spawnSync("git", ["-C", repo, "show-ref", "--verify", "refs/tags/must-fail"], { env }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
