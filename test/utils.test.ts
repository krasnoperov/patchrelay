import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  redactSensitiveHeaders,
  ensureAbsolutePath,
  execCommand,
  extractFirstJsonObject,
  interpolateTemplate,
  interpolateTemplateArray,
  sanitizeDiagnosticText,
  safeJsonParse,
  timestampMsWithinSkew,
  verifyHmacSha256Hex,
} from "../src/utils.ts";

test("utils cover path, template, and json helpers", () => {
  assert.equal(ensureAbsolutePath("/tmp/x"), "/tmp/x");
  assert.ok(ensureAbsolutePath("relative/path").endsWith("relative/path"));

  assert.equal(interpolateTemplate("hello {name}", { name: "world" }), "hello world");
  assert.deepEqual(interpolateTemplateArray(["{a}", "{b}", "{missing}"], { a: "1", b: "2" }), ["1", "2", ""]);

  assert.deepEqual(safeJsonParse<{ ok: boolean }>("{\"ok\":true}"), { ok: true });
  assert.equal(safeJsonParse("{oops"), undefined);

  assert.equal(extractFirstJsonObject("prefix {\"a\":{\"b\":1}} suffix"), "{\"a\":{\"b\":1}}");
  assert.equal(extractFirstJsonObject("text without object"), undefined);
  assert.equal(extractFirstJsonObject("say {\"quoted\":\"}\\\" still inside\"} done"), "{\"quoted\":\"}\\\" still inside\"}");
  assert.deepEqual(
    redactSensitiveHeaders({
      authorization: "Bearer secret",
      "linear-signature": "abc",
      "content-type": "application/json",
    }),
    {
      authorization: "[redacted]",
      "linear-signature": "[redacted]",
      "content-type": "application/json",
    },
  );

  assert.equal(sanitizeDiagnosticText("Authorization: Bearer secret-token"), "Authorization: Bearer [redacted]");
  assert.equal(sanitizeDiagnosticText("access_token=abc123 refreshToken=def456"), "access_token=[redacted] refreshToken=[redacted]");
  assert.equal(sanitizeDiagnosticText("secret=abc123"), "secret=[redacted]");
  assert.match(sanitizeDiagnosticText(`prefix ${"x".repeat(600)}`), /\[truncated\]$/);
});

test("utils cover timestamp skew and hmac validation", () => {
  const now = Date.now();
  assert.equal(timestampMsWithinSkew(now, 1), true);
  assert.equal(timestampMsWithinSkew(now - 5_000, 1), false);

  const raw = Buffer.from("{\"ok\":true}", "utf8");
  const secret = "secret";
  const signature = crypto.createHmac("sha256", secret).update(raw).digest("hex");

  assert.equal(verifyHmacSha256Hex(raw, secret, signature), true);
  assert.equal(verifyHmacSha256Hex(raw, secret, signature.toUpperCase()), true);
  assert.equal(verifyHmacSha256Hex(raw, secret, ""), false);
  assert.equal(verifyHmacSha256Hex(raw, secret, "xyz"), false);
  assert.equal(verifyHmacSha256Hex(raw, "wrong-secret", signature), false);
});

test("execCommand captures output and timeout failures", async () => {
  const success = await execCommand(
    process.execPath,
    ["-e", "require('node:fs').writeSync(1, 'out\\n'); require('node:fs').writeSync(2, 'err\\n')"],
  );
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout.trim(), "out");
  assert.equal(success.stderr.trim(), "err");

  await assert.rejects(
    () => execCommand(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { timeoutMs: 10 }),
    /Command timed out after 10ms/,
  );

  await assert.rejects(
    () => execCommand("definitely-not-a-real-patchrelay-command", ["--version"]),
    /ENOENT/,
  );
});
