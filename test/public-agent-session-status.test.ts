import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionStatusUrl,
  createSessionStatusToken,
  deriveSessionStatusSigningSecret,
  verifySessionStatusToken,
} from "../src/public-agent-session-status.ts";

test("session status token round-trips and validates expiry", () => {
  const nowMs = Date.UTC(2026, 2, 17, 12, 0, 0);
  const secret = deriveSessionStatusSigningSecret("encryption-key");
  const created = createSessionStatusToken({
    issueKey: "USE-42",
    secret,
    nowMs,
    ttlSeconds: 600,
  });

  const valid = verifySessionStatusToken(created.token, secret, nowMs + 300_000);
  assert.deepEqual(valid, {
    issueKey: "USE-42",
    expiresAt: created.expiresAt,
  });

  const expired = verifySessionStatusToken(created.token, secret, nowMs + 601_000);
  assert.equal(expired, undefined);
});

test("session status token rejects tampering", () => {
  const secret = deriveSessionStatusSigningSecret("encryption-key");
  const created = createSessionStatusToken({
    issueKey: "USE-7",
    secret,
    nowMs: Date.UTC(2026, 2, 17, 12, 0, 0),
    ttlSeconds: 3600,
  });
  const [payload] = created.token.split(".");
  const tampered = `${payload}.bad-signature`;
  assert.equal(verifySessionStatusToken(tampered, secret), undefined);
});

test("session status URL helper builds a stable public path", () => {
  const url = buildSessionStatusUrl({
    publicBaseUrl: "https://patchrelay.example.com",
    issueKey: "USE-42",
    token: "token-value",
  });
  assert.equal(url, "https://patchrelay.example.com/agent/session/USE-42?token=token-value");
});
