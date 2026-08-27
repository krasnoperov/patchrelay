import { z } from "zod";

export const reviewVerdictSchema = z.strictObject({
  walkthrough: z.string(),
  architectural_concerns: z.array(z.strictObject({
    severity: z.enum(["blocking", "nit"]),
    category: z.string().min(1),
    message: z.string().min(1),
  })),
  findings: z.array(z.strictObject({
    path: z.string().min(1),
    line: z.number().int().positive(),
    severity: z.enum(["blocking", "nit"]),
    message: z.string().min(1),
    confidence: z.number().min(0).max(100).nullable(),
    suggestion: z.string().nullable(),
  })),
  verdict: z.enum(["approve", "request_changes"]),
  verdict_reason: z.string().min(1),
});

/** Canonical executable JSON Schema for ReviewVerdict model output.
 * Nullable optional values stay required at the wire boundary so the model
 * emits one stable shape; normalizeVerdict omits null values internally. */
export const REVIEW_VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["walkthrough", "architectural_concerns", "findings", "verdict", "verdict_reason"],
  properties: {
    walkthrough: { type: "string" },
    architectural_concerns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "message"],
        properties: {
          severity: { type: "string", enum: ["blocking", "nit"] },
          category: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1 },
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "line", "severity", "message", "confidence", "suggestion"],
        properties: {
          path: { type: "string", minLength: 1 },
          line: { type: "integer", minimum: 1 },
          severity: { type: "string", enum: ["blocking", "nit"] },
          message: { type: "string", minLength: 1 },
          confidence: { type: ["number", "null"], minimum: 0, maximum: 100 },
          suggestion: { type: ["string", "null"] },
        },
      },
    },
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    verdict_reason: { type: "string", minLength: 1 },
  },
} as const;

export type ReviewVerdictJsonSchema = typeof REVIEW_VERDICT_JSON_SCHEMA;
