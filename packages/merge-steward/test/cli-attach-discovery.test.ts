import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

const noop = async () => ({ exitCode: 0, stdout: "", stderr: "" });

test("attach owner/repo auto-discovers repo settings and derives the repo id", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-attach-discovery-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      assert.equal(init?.method, "POST");
      return createJsonResponse({ token: "installation-token" });
    }
    if (url.endsWith("/repos/example/api-service")) {
      return createJsonResponse({ default_branch: "trunk" });
    }
    if (url.endsWith("/repos/example/api-service/rules/branches/trunk")) {
      return createJsonResponse([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "lint" }, { context: "test" }],
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
        MERGE_STEWARD_GITHUB_APP_ID: "123456",
        MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID: "123",
        MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY: createPrivateKeyPem(),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        const code = await runCli(["attach", "example/api-service"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        assert.equal(code, 0);
        const text = stdout.read();
        assert.match(text, /Attached repo api-service for example\/api-service/);
        assert.match(text, /Base branch: trunk/);
        assert.match(text, /Required checks: lint, test/);

        const repoConfig = readFileSync(path.join(baseDir, ".config", "merge-steward", "repos", "api-service.json"), "utf8");
        assert.match(repoConfig, /"baseBranch": "trunk"/);
        assert.match(repoConfig, /"requiredChecks": \[/);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("attach --refresh re-discovers required checks for an existing repo", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-attach-refresh-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      assert.equal(init?.method, "POST");
      return createJsonResponse({ token: "installation-token" });
    }
    if (url.endsWith("/repos/example/repo")) {
      return createJsonResponse({ default_branch: "main" });
    }
    if (url.endsWith("/repos/example/repo/rules/branches/main")) {
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
        MERGE_STEWARD_GITHUB_APP_ID: "123456",
        MERGE_STEWARD_GITHUB_APP_INSTALLATION_ID: "123",
        MERGE_STEWARD_GITHUB_APP_PRIVATE_KEY: createPrivateKeyPem(),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        await runCli(["attach", "app", "example/repo", "--base-branch", "main", "--required-check", "lint"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        const code = await runCli(["attach", "app", "example/repo", "--refresh"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        assert.equal(code, 0);
        assert.match(stdout.read(), /Required checks: test/);

        const repoConfig = readFileSync(path.join(baseDir, ".config", "merge-steward", "repos", "app.json"), "utf8");
        assert.match(repoConfig, /"requiredChecks": \[\n    "test"\n  \]/);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
