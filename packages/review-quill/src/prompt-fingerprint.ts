import { createHash } from "node:crypto";
import type { PullRequestSummary } from "./types.ts";

export function buildPromptFingerprint(
  pr: Pick<PullRequestSummary, "title" | "body" | "labels">,
): string {
  const payload = {
    v: 1,
    title: pr.title,
    body: pr.body ?? "",
    labels: [...pr.labels].sort(),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
