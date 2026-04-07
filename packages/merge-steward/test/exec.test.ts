import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { exec, setRuntimeGitHubAuthProvider } from "../src/exec.ts";

test("exec retries git without runtime GitHub auth after workflow permission rejection", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "merge-steward-exec-"));
  const gitPath = path.join(tempDir, "git");
  const logPath = path.join(tempDir, "attempts.log");

  try {
    writeFileSync(
      gitPath,
      `#!/usr/bin/env bash
set -euo pipefail
LOG_PATH="${logPath}"
if env | grep -q '^GIT_CONFIG_VALUE_[0-9]*=AUTHORIZATION: basic '; then
  printf 'with-app-auth\\n' >> "$LOG_PATH"
  cat >&2 <<'EOF'
To https://github.com/krasnoperov/ballony-i-nasosy.git
 ! [remote rejected] mq-spec-test -> mq-spec-test (refusing to allow a GitHub App to create or update workflow \`.github/workflows/ci-deploy.yml\` without \`workflows\` permission)
error: failed to push some refs to 'https://github.com/krasnoperov/ballony-i-nasosy.git'
EOF
  exit 1
fi
printf 'fallback-auth\\n' >> "$LOG_PATH"
printf 'push ok\\n'
`,
    );
    chmodSync(gitPath, 0o755);

    setRuntimeGitHubAuthProvider({
      currentTokenForRepo(repoFullName?: string) {
        return repoFullName === "krasnoperov/ballony-i-nasosy" ? "runtime-token" : undefined;
      },
    });

    const result = await exec(
      "git",
      ["push", "--force-with-lease", "origin", "mq-spec-test"],
      {
        env: {
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        },
        githubRepoFullName: "krasnoperov/ballony-i-nasosy",
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /push ok/);
    assert.equal(readFileSync(logPath, "utf8"), "with-app-auth\nfallback-auth\n");
  } finally {
    setRuntimeGitHubAuthProvider(undefined);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
