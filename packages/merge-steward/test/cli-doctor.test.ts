import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";

function createBufferStream() {
  let buffer = "";
  return {
    stream: {
      write(chunk: string): boolean {
        buffer += chunk;
        return true;
      },
    },
    read(): string {
      return buffer;
    },
  };
}

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> | void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  try {
    const result = run();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

const noop = async () => ({ exitCode: 0, stdout: "", stderr: "" });

function createPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("doctor without init reports failing home-config check", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-doctor-noinit-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
        MERGE_STEWARD_WEBHOOK_SECRET: undefined,
      },
      async () => {
        const stdout = createBufferStream();
        const code = await runCli(["doctor"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        assert.equal(code, 1);
        const text = stdout.read();
        assert.match(text, /\[fail\] home-config:/);
        assert.match(text, /\[fail\] github-auth:/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("doctor after init passes home and path checks", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-doctor-init-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
        MERGE_STEWARD_WEBHOOK_SECRET: undefined,
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        await runCli(["doctor"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        const text = stdout.read();
        assert.match(text, /\[pass\] home-config:/);
        assert.match(text, /\[pass\] runtime-env:/);
        assert.match(text, /\[pass\] service-env:/);
        assert.match(text, /\[pass\] repo-config-dir:/);
        assert.match(text, /\[pass\] state-dir:/);
        assert.match(text, /\[pass\] systemd-unit:/);
        assert.match(text, /\[warn\] webhook-secret:/);
        assert.match(text, /\[fail\] github-auth:/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("doctor --json emits structured output", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-doctor-json-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
        MERGE_STEWARD_WEBHOOK_SECRET: undefined,
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        await runCli(["doctor", "--json"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        const result = JSON.parse(stdout.read()) as { ok: boolean; checks: Array<{ status: string; scope: string; message: string }> };
        assert.equal(typeof result.ok, "boolean");
        assert.ok(Array.isArray(result.checks));
        assert.ok(result.checks.length > 0);
        assert.ok(result.checks.every((c) => ["pass", "warn", "fail"].includes(c.status)));
        assert.ok(result.checks.every((c) => typeof c.scope === "string"));
        assert.ok(result.checks.every((c) => typeof c.message === "string"));
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("doctor with --repo validates repo config", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-doctor-repo-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
        MERGE_STEWARD_WEBHOOK_SECRET: undefined,
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        await runCli(["doctor", "--repo", "app"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        const text = stdout.read();
        assert.match(text, /\[pass\] repo:app:.*valid for owner\/repo/);
        assert.match(text, /\[pass\] repo:app:database-dir/);
        assert.match(text, /\[pass\] repo:app:clone-parent/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("doctor reports the configured queue eviction check", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-doctor-queue-check-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
        MERGE_STEWARD_WEBHOOK_SECRET: undefined,
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo", "--merge-queue-check-name", "custom/queue-eviction"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        await runCli(["doctor", "--repo", "app", "--json"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        const result = JSON.parse(stdout.read()) as {
          ok: boolean;
          checks: Array<{ status: string; scope: string; message: string }>;
        };
        const queueCheck = result.checks.find((check) => check.scope === "repo:app:merge-queue-check");
        assert.ok(queueCheck);
        assert.equal(queueCheck?.status, "pass");
        assert.match(queueCheck?.message ?? "", /custom\/queue-eviction/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("doctor --repo with nonexistent repo reports failure", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-doctor-norepo-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
        MERGE_STEWARD_WEBHOOK_SECRET: undefined,
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        const code = await runCli(["doctor", "--repo", "nonexistent"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        assert.equal(code, 1);
        assert.match(stdout.read(), /\[fail\] repo:nonexistent:.*not found/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("doctor passes webhook-secret and GitHub App checks when env vars are set", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-doctor-secret-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
        MERGE_STEWARD_WEBHOOK_SECRET: "test-secret",
        MERGE_STEWARD_GITHUB_APP_ID: "123456",
        MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        await runCli(["doctor", "--json"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        const result = JSON.parse(stdout.read()) as { checks: Array<{ status: string; scope: string }> };
        const secretCheck = result.checks.find((c) => c.scope === "webhook-secret");
        const authCheck = result.checks.find((c) => c.scope === "github-auth");
        const appCheck = result.checks.find((c) => c.scope === "github-app");
        assert.equal(secretCheck?.status, "pass");
        assert.equal(authCheck?.status, "pass");
        assert.equal(appCheck?.status, "pass");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("doctor accepts GitHub App credentials without a direct token", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-doctor-app-auth-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
        MERGE_STEWARD_WEBHOOK_SECRET: "test-secret",
        MERGE_STEWARD_GITHUB_APP_ID: "123456",
        MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID: "987654",
        MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        await runCli(["doctor", "--json"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        const result = JSON.parse(stdout.read()) as {
          checks: Array<{ status: string; scope: string; message: string }>;
        };
        const authCheck = result.checks.find((c) => c.scope === "github-auth");
        const appCheck = result.checks.find((c) => c.scope === "github-app");
        assert.equal(authCheck?.status, "pass");
        assert.equal(appCheck?.status, "pass");
        assert.match(appCheck?.message ?? "", /987654/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("doctor warns when local base branch and required checks drift from GitHub", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-doctor-drift-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/987654/access_tokens")) {
      assert.equal(init?.method, "POST");
      return createJsonResponse({ token: "installation-token" });
    }
    if (url.endsWith("/repos/owner/repo")) {
      return createJsonResponse({ default_branch: "main" });
    }
    if (url.endsWith("/repos/owner/repo/rules/branches/release")) {
      return createJsonResponse([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "test" }],
          },
        },
      ]);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
        MERGE_STEWARD_WEBHOOK_SECRET: "test-secret",
        MERGE_STEWARD_GITHUB_APP_ID: "123456",
        MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID: "987654",
        MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY: createPrivateKeyPem(),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo", "--base-branch", "release", "--required-check", "lint"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        await runCli(["doctor", "--repo", "app", "--json"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        const result = JSON.parse(stdout.read()) as {
          checks: Array<{ status: string; scope: string; message: string }>;
        };
        const branchCheck = result.checks.find((check) => check.scope === "repo:app:github-default-branch");
        const requiredChecks = result.checks.find((check) => check.scope === "repo:app:github-required-checks");
        assert.equal(branchCheck?.status, "warn");
        assert.match(branchCheck?.message ?? "", /GitHub default branch is main/);
        assert.equal(requiredChecks?.status, "warn");
        assert.match(requiredChecks?.message ?? "", /\[lint\].*\[test\]/);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
