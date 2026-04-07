import { createHmac, timingSafeEqual } from "node:crypto";

export interface ReviewQuillWebhookEvent {
  type: "pull_request" | "check_run" | "check_suite";
  repoFullName: string;
  prNumber?: number;
}

export function verifySignature(rawBody: Buffer, secret: string, signature: string | undefined): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.slice("sha256=".length);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}

export function normalizeWebhook(eventType: string, payload: Record<string, unknown>): ReviewQuillWebhookEvent | undefined {
  const repo = payload.repository as Record<string, unknown> | undefined;
  const repoFullName = typeof repo?.full_name === "string" ? repo.full_name : undefined;
  if (!repoFullName) return undefined;

  if (eventType === "pull_request" && payload.pull_request && typeof (payload.pull_request as Record<string, unknown>).number === "number") {
    return {
      type: "pull_request",
      repoFullName,
      prNumber: Number((payload.pull_request as Record<string, unknown>).number),
    };
  }

  if (eventType === "check_run" || eventType === "check_suite") {
    return {
      type: eventType,
      repoFullName,
    };
  }

  return undefined;
}
