// Token estimation for budget accounting.
//
// Review-quill needs a rough token count to decide how many patches fit in
// the prompt budget. We avoid native addons like `tiktoken` by using a
// bytes-per-token heuristic: source code averages ~3.5-4 bytes per token
// across GPT/Claude tokenizers, so dividing UTF-8 byte length by 3.5 gives
// a safe overestimate (~10-15% pessimistic vs tiktoken) that keeps us
// inside the real budget without under-filling the prompt.
//
// This matches the philosophy of PR-Agent's `model_token_count_estimate_factor`
// (they multiply tiktoken's count by 1.3 as a safety margin); we apply the
// same margin directly in the divisor.

const BYTES_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

// Per-file framing overhead in the rendered prompt:
//   ## <path>\n```diff\n<patch>\n```\n
// Path length varies, but 60 chars is a conservative average. 16 bytes for
// the fixed framing (`## `, `\n\`\`\`diff\n`, `\n\`\`\`\n`) plus the path
// → ~80 bytes per file, worth ~23 tokens.
export const PATCH_FRAMING_OVERHEAD_BYTES = 80;
export const PATCH_FRAMING_OVERHEAD_TOKENS = Math.ceil(PATCH_FRAMING_OVERHEAD_BYTES / BYTES_PER_TOKEN);
