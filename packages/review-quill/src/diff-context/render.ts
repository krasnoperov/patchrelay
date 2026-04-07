import { humanReason } from "./summarize.ts";
import type { ReviewDiffContext } from "../types.ts";

// Render order is:
//   1. `Changed files inventory:` — every file, one line. Files without
//      a reason are included as full patches below; files with a reason
//      (plain English) are suppressed and will NOT appear in the
//      `Detailed patches:` section. The inventory is the single source
//      of truth — there is no separate suppressed-files section because
//      it would be 100% redundant with what's already here.
//   2. `Detailed patches:` — a `\`\`\`diff\`\`\`` block per surviving
//      patch.
export function renderDiffContextLines(diff: ReviewDiffContext): string[] {
  const lines: string[] = ["Changed files inventory:"];

  for (const file of diff.inventory) {
    const stats = `${file.status} +${file.additions} -${file.deletions}`;
    const reasonSuffix = file.reason ? ` — ${humanReason(file.reason)}` : "";
    lines.push(`- ${file.path} (${stats})${reasonSuffix}`);
  }

  if (diff.patches.length > 0) {
    lines.push("", "Detailed patches:");
    for (const file of diff.patches) {
      lines.push(`## ${file.path}`);
      lines.push("```diff", file.patch, "```");
    }
  }

  return lines;
}
