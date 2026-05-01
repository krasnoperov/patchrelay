export type FollowupIntent =
  | "stop"
  | "status"
  | "question"
  | "clarification"
  | "implementation_request"
  | "retry";

const IMPLEMENTATION_PATTERNS = [
  /\b(add|address|adjust|change|create|delete|deploy|fix|implement|install|merge|open|polish|publish|push|remove|rename|set|ship|update)\b/i,
  /\b(go on and|go ahead and|please|pls)\s+\b(add|address|adjust|change|create|delete|deploy|fix|implement|install|merge|open|polish|publish|push|remove|rename|set|ship|update|use)\b/i,
  /\b(use|keep|switch|move)\b.+\b(instead|copy|api|contract|behavior|state|repo|branch|team|issue|pr)\b/i,
];

const RETRY_PATTERNS = [
  /\b(continue|go on|keep going|proceed|resume)\b/i,
  /\b(retry|try again|rerun|run again|restart)\b/i,
  /\b(next task|next issue)\b/i,
];

const STOP_PATTERNS = [
  /\b(stop|cancel|halt|abort)\b/i,
  /\b(pause|hold)\s+(work|implementation|the run|patchrelay)\b/i,
  /\bdo not\s+(continue|proceed|work|implement)\b/i,
];

const STATUS_PATTERNS = [
  /\b(status|progress)\b/i,
  /\b(status update|progress update|any update|quick update)\b/i,
  /\b(where are we|what'?s happening|what is happening|what'?s deployed|what is deployed)\b/i,
  /\b(done so far|deployed so far|current work|current run)\b/i,
];

const CLARIFICATION_PATTERNS = [
  /\b(fyi|for context|heads up|to clarify|clarification|correction|actually|note that)\b/i,
  /\b(i meant|what i meant|not asking you to|no action needed)\b/i,
];

const QUESTION_PATTERNS = [
  /\?$/,
  /\b(can|could|do|does|did|is|are|was|were|why|how|what|when|where|which|who|should|would)\b/i,
];

export function classifyFollowupIntent(input: string): FollowupIntent {
  const text = input.trim();
  if (!text) return "clarification";

  if (matchesAny(text, STOP_PATTERNS)) return "stop";
  if (matchesAny(text, RETRY_PATTERNS)) return "retry";
  if (matchesAny(text, STATUS_PATTERNS)) return "status";
  if (matchesAny(text, IMPLEMENTATION_PATTERNS)) return "implementation_request";
  if (matchesAny(text, CLARIFICATION_PATTERNS)) return "clarification";
  if (matchesAny(text, QUESTION_PATTERNS)) return "question";

  return "clarification";
}

export function followupIntentQueuesWork(intent: FollowupIntent): intent is "implementation_request" | "retry" {
  return intent === "implementation_request" || intent === "retry";
}

export function followupIntentIsNonActionable(intent: FollowupIntent): intent is "status" | "question" | "clarification" {
  return intent === "status" || intent === "question" || intent === "clarification";
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}
