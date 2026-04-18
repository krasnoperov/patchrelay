import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { discoverRepoSettings, normalizeCheckList } from "../src/github-repo-discovery.ts";

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

test("discoverRepoSettings resolves default branch and required checks from GitHub", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      assert.equal(init?.method, "POST");
      return createJsonResponse({ token: "installation-token" });
    }
    if (url.endsWith("/repos/owner/repo")) {
      return createJsonResponse({ default_branch: "main" });
    }
    if (url.endsWith("/repos/owner/repo/rules/branches/main")) {
      return createJsonResponse([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "lint" },
              { context: "test" },
            ],
          },
        },
      ]);
    }
    if (url.endsWith("/repos/owner/repo/branches/main/protection")) {
      return new Response("not found", { status: 404 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const discovered = await discoverRepoSettings(
      {
        appId: "123456",
        installationId: "123",
        privateKey: createPrivateKeyPem(),
      },
      "owner/repo",
    );

    assert.equal(discovered.defaultBranch, "main");
    assert.equal(discovered.branch, "main");
    assert.deepEqual(discovered.requiredChecks, ["lint", "test"]);
    assert.equal(discovered.requireAllChecksOnEmptyRequiredSet, false);
    assert.deepEqual(discovered.warnings, []);
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverRepoSettings warns when GitHub only exposes workflow rules or no required checks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      assert.equal(init?.method, "POST");
      return createJsonResponse({ token: "installation-token" });
    }
    if (url.endsWith("/repos/owner/repo")) {
      return createJsonResponse({ default_branch: "main" });
    }
    if (url.endsWith("/repos/owner/repo/rules/branches/release")) {
      return createJsonResponse([
        { type: "workflows", parameters: {} },
      ]);
    }
    if (url.endsWith("/repos/owner/repo/branches/release/protection")) {
      return new Response("not found", { status: 404 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const discovered = await discoverRepoSettings(
      {
        appId: "123456",
        installationId: "123",
        privateKey: createPrivateKeyPem(),
      },
      "owner/repo",
      { baseBranch: "release" },
    );

    assert.equal(discovered.defaultBranch, "main");
    assert.equal(discovered.branch, "release");
    assert.deepEqual(discovered.requiredChecks, []);
    assert.equal(discovered.requireAllChecksOnEmptyRequiredSet, false);
    assert.equal(discovered.warnings.length, 2);
    assert.match(discovered.warnings[0] ?? "", /require workflows/i);
    assert.match(discovered.warnings[1] ?? "", /No required status checks discovered/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverRepoSettings falls back to classic branch protection required checks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      assert.equal(init?.method, "POST");
      return createJsonResponse({ token: "installation-token" });
    }
    if (url.endsWith("/repos/owner/repo")) {
      return createJsonResponse({ default_branch: "main" });
    }
    if (url.endsWith("/repos/owner/repo/rules/branches/main")) {
      return createJsonResponse([]);
    }
    if (url.endsWith("/repos/owner/repo/branches/main/protection")) {
      return createJsonResponse({
        required_status_checks: {
          contexts: ["Verify"],
          checks: [{ context: "Verify" }],
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const discovered = await discoverRepoSettings(
      {
        appId: "123456",
        installationId: "123",
        privateKey: createPrivateKeyPem(),
      },
      "owner/repo",
    );

    assert.equal(discovered.defaultBranch, "main");
    assert.equal(discovered.branch, "main");
    assert.deepEqual(discovered.requiredChecks, ["Verify"]);
    assert.equal(discovered.requireAllChecksOnEmptyRequiredSet, false);
    assert.deepEqual(discovered.warnings, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverRepoSettings requires all observed checks when protection is strict but contexts are empty", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/app/installations/123/access_tokens")) {
      assert.equal(init?.method, "POST");
      return createJsonResponse({ token: "installation-token" });
    }
    if (url.endsWith("/repos/owner/repo")) {
      return createJsonResponse({ default_branch: "main" });
    }
    if (url.endsWith("/repos/owner/repo/rules/branches/main")) {
      return createJsonResponse([]);
    }
    if (url.endsWith("/repos/owner/repo/branches/main/protection")) {
      return createJsonResponse({
        required_status_checks: {
          strict: true,
          contexts: [],
          checks: [],
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const discovered = await discoverRepoSettings(
      {
        appId: "123456",
        installationId: "123",
        privateKey: createPrivateKeyPem(),
      },
      "owner/repo",
    );

    assert.equal(discovered.defaultBranch, "main");
    assert.equal(discovered.branch, "main");
    assert.deepEqual(discovered.requiredChecks, []);
    assert.equal(discovered.requireAllChecksOnEmptyRequiredSet, true);
    assert.equal(discovered.warnings.length, 1);
    assert.match(discovered.warnings[0] ?? "", /require all observed checks on the ref to pass/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeCheckList de-duplicates and sorts check names", () => {
  assert.deepEqual(normalizeCheckList(["test", "lint", "test", ""]), ["lint", "test"]);
});
