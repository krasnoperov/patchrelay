import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../src/token-crypto.ts";

test("encryptSecret and decryptSecret round-trip plaintext", () => {
  const secret = "encryption-key";
  const plaintext = "super-secret-token";

  const ciphertext = encryptSecret(plaintext, secret);

  assert.notEqual(ciphertext, plaintext);
  assert.equal(decryptSecret(ciphertext, secret), plaintext);
});

test("decryptSecret rejects the wrong secret", () => {
  const ciphertext = encryptSecret("super-secret-token", "correct-secret");

  assert.throws(() => decryptSecret(ciphertext, "wrong-secret"));
});
