import type { DiffSuppressedEntry } from "../types.ts";

export function summarizeSuppressedFile(entry: DiffSuppressedEntry): string {
  return `${entry.path} (${entry.status}, +${entry.additions} -${entry.deletions}) omitted: ${entry.reason}`;
}
