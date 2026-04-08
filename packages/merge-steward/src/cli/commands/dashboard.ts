import type { ParsedArgs } from "../types.ts";
import { parseIntegerFlag } from "../args.ts";
import { loadRepoConfigById } from "../system.ts";

export async function handleDashboard(parsed: ParsedArgs): Promise<number> {
  const initialRepoRef = typeof parsed.flags.get("repo") === "string"
    ? String(parsed.flags.get("repo"))
    : undefined;
  const initialPrNumber = parseIntegerFlag(parsed.flags.get("pr"), "--pr");

  const options: { initialRepoRef?: string; initialPrNumber?: number } = {};
  if (initialRepoRef) {
    loadRepoConfigById(initialRepoRef);
    options.initialRepoRef = initialRepoRef;
  }
  if (initialPrNumber !== undefined) {
    options.initialPrNumber = initialPrNumber;
  }

  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    process.stderr.write("merge-steward dashboard requires an interactive TTY.\n");
    process.stderr.write("Use `merge-steward queue status --repo <id>` or run the dashboard from a terminal.\n");
    return 1;
  }

  const { startDashboard } = await import("../../watch/index.tsx");
  await startDashboard(options);
  return 0;
}
