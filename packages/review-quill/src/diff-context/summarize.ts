// Map internal suppression reason codes to plain English. The rendered
// prompt is an LLM's primary input, so inventory reasons should be
// directly parseable rather than machine shorthand.
//
// Keep phrases short (under ~6 tokens each) to avoid bloating the
// inventory on large PRs with lots of suppressed files.
const REASON_TEXT: Record<string, string> = {
  ignored_by_policy: "ignored by rule",
  summarize_only_policy: "summary only by rule",
  budget_exceeded: "too large for budget",
  no_additions: "pure deletion",
  binary_file: "binary file",
  suppressed: "suppressed",
};

export function humanReason(reason: string): string {
  return REASON_TEXT[reason] ?? reason.replaceAll("_", " ");
}
