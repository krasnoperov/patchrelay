import type { LinearAgentActivityContent } from "./types.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";

export function computeLinearActivityKey(content: LinearAgentActivityContent): string {
  if (content.type === "action") {
    const action = sanitizeOperatorFacingText(content.action) ?? content.action;
    const parameter = sanitizeOperatorFacingText(content.parameter) ?? content.parameter;
    const result = sanitizeOperatorFacingText(content.result);
    return `action:${action}:${parameter}:${result ?? ""}`;
  }

  const body = sanitizeOperatorFacingText(content.body) ?? content.body;
  return `${content.type}:${body}`;
}
