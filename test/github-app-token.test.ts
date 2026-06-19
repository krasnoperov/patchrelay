import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { generateJwt } from "../src/github-app-token.ts";

function privateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

function decodeJwtPayload(token: string): { iat: number; exp: number; iss: string } {
  const [, payload] = token.split(".");
  assert.ok(payload, "expected JWT payload");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iat: number; exp: number; iss: string };
}

test("generateJwt stays within GitHub App's 10 minute lifetime limit", () => {
  const jwt = generateJwt("123456", privateKeyPem());
  const payload = decodeJwtPayload(jwt);

  assert.equal(payload.iss, "123456");
  assert.equal(payload.exp - payload.iat, 10 * 60);
});
