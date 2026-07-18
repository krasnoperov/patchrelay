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
          category: { type: "string" },
          message: { type: "string" },
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
          path: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["blocking", "nit"] },
          message: { type: "string" },
          confidence: { type: ["number", "null"] },
          suggestion: { type: ["string", "null"] },
        },
      },
    },
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    verdict_reason: { type: "string" },
  },
} as const;

export type ReviewVerdictJsonSchema = typeof REVIEW_VERDICT_JSON_SCHEMA;
