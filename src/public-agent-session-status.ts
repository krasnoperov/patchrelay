import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 1;
const DEFAULT_TTL_SECONDS = 60 * 60 * 24;
const PURPOSE = "patchrelay-agent-session-status";

interface SessionStatusTokenPayload {
  v: number;
  i: string;
  exp: number;
}

export interface CreateSessionStatusTokenParams {
  issueKey: string;
  secret: string;
  nowMs?: number;
  ttlSeconds?: number;
}

export interface ParsedSessionStatusToken {
  issueKey: string;
  expiresAt: string;
}

export function createSessionStatusToken(params: CreateSessionStatusTokenParams): ParsedSessionStatusToken & { token: string } {
  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const ttlSeconds = Number.isFinite(params.ttlSeconds) ? Math.max(60, Math.floor(params.ttlSeconds ?? DEFAULT_TTL_SECONDS)) : DEFAULT_TTL_SECONDS;
  const payload: SessionStatusTokenPayload = {
    v: TOKEN_VERSION,
    i: params.issueKey,
    exp: nowSeconds + ttlSeconds,
  };
  const payloadEncoded = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = signPayload(payloadEncoded, params.secret);
  return {
    token: `${payloadEncoded}.${signature}`,
    issueKey: payload.i,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export function verifySessionStatusToken(token: string, secret: string, nowMs?: number): ParsedSessionStatusToken | undefined {
  const [payloadEncoded, signatureEncoded] = token.split(".", 2);
  if (!payloadEncoded || !signatureEncoded) {
    return undefined;
  }

  const expectedSignature = signPayload(payloadEncoded, secret);
  if (!timingSafeEqualUtf8(signatureEncoded, expectedSignature)) {
    return undefined;
  }

  const payload = parsePayload(payloadEncoded);
  if (!payload || payload.v !== TOKEN_VERSION || typeof payload.i !== "string" || typeof payload.exp !== "number") {
    return undefined;
  }

  const nowSeconds = Math.floor((nowMs ?? Date.now()) / 1000);
  if (payload.exp < nowSeconds) {
    return undefined;
  }

  return {
    issueKey: payload.i,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export function buildSessionStatusUrl(params: {
  publicBaseUrl: string;
  issueKey: string;
  token: string;
}): string {
  const url = new URL(`/agent/session/${encodeURIComponent(params.issueKey)}`, params.publicBaseUrl);
  url.searchParams.set("token", params.token);
  return url.toString();
}

export function deriveSessionStatusSigningSecret(tokenEncryptionKey: string): string {
  return `${PURPOSE}:${tokenEncryptionKey}`;
}

function signPayload(payloadEncoded: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(payloadEncoded).digest();
  return encodeBase64Url(digest);
}

function parsePayload(payloadEncoded: string): SessionStatusTokenPayload | undefined {
  try {
    const decoded = decodeBase64Url(payloadEncoded).toString("utf8");
    return JSON.parse(decoded) as SessionStatusTokenPayload;
  } catch {
    return undefined;
  }
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function timingSafeEqualUtf8(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
