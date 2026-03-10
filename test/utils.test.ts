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
  safeJsonParse,
  timestampMsWithinSkew,
  verifyHmacSha256Hex,
} from "../src/utils.js";

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
  const success = await execCommand(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout, "out");
  assert.equal(success.stderr, "err");

  await assert.rejects(
    () => execCommand(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { timeoutMs: 10 }),
    /Command timed out after 10ms/,
  );
});
