import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildDetailLines } from "./detail-rows.ts";
import { lineToPlainText } from "./render-rich-text.ts";
import type { TimelineEntry, TimelineRunInput } from "./timeline-builder.ts";
import type { DetailTab, OperatorFeedEvent, WatchDiffSummary, WatchIssue, WatchIssueContext, WatchTokenUsage } from "./watch-state.ts";

interface WatchDetailExportInput {
  issue: WatchIssue;
  timeline: TimelineEntry[];
  activeRunStartedAt: string | null;
  activeRunId: number | null;
  tokenUsage: WatchTokenUsage | null;
  diffSummary: WatchDiffSummary | null;
  plan: Array<{ step: string; status: string }> | null;
  issueContext: WatchIssueContext | null;
  detailTab: DetailTab;
  rawRuns: TimelineRunInput[];
  rawFeedEvents: OperatorFeedEvent[];
  width?: number | undefined;
}

export function findLastAssistantMessage(timeline: TimelineEntry[]): string | null {
  return findLastItemField(timeline, (entry) => entry.item?.type === "agentMessage", "text");
}

export function findLastCommand(timeline: TimelineEntry[]): string | null {
  return findLastItemField(timeline, (entry) => entry.item?.type === "commandExecution", "command");
}

export function findLastCommandOutput(timeline: TimelineEntry[]): string | null {
  return findLastItemField(timeline, (entry) => entry.item?.type === "commandExecution" && Boolean(entry.item?.output?.trim()), "output");
}

export function buildWatchDetailExportText(input: WatchDetailExportInput): string {
  const lines = buildDetailLines({
    ...input,
    width: input.width ?? 100,
  });
  return `${lines.map(lineToPlainText).join("\n").trimEnd()}\n`;
}

export function writeTextToClipboard(text: string, stream: NodeJS.WriteStream = process.stderr): boolean {
  if (!stream.isTTY || text.length === 0) {
    return false;
  }

  const encoded = Buffer.from(text, "utf8").toString("base64");
  stream.write(`\u001b]52;c;${encoded}\u0007`);
  return true;
}

export function exportWatchTextToTempFile(text: string, issueKey: string): string {
  const directory = mkdtempSync(join(tmpdir(), "patchrelay-watch-"));
  const safeIssueKey = issueKey.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const filePath = join(directory, `${safeIssueKey || "issue"}-transcript.txt`);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

export function openTextInPager(text: string, stream: NodeJS.WriteStream = process.stderr): { ok: boolean; reason?: string } {
  if (!stream.isTTY) {
    return { ok: false, reason: "interactive TTY required" };
  }
  const streamWithFd = stream as NodeJS.WriteStream & { fd?: number };
  if (typeof streamWithFd.fd !== "number") {
    return { ok: false, reason: "TTY stream fd unavailable" };
  }

  const pagerCommand = process.env.PAGER?.trim() || "less -R";
  stream.write("\u001b[?1049l");
  try {
    const result = spawnSync("/bin/sh", ["-lc", pagerCommand], {
      input: text,
      stdio: ["pipe", streamWithFd.fd, streamWithFd.fd],
    });
    if (result.error) {
      return { ok: false, reason: result.error.message };
    }
    if (typeof result.status === "number" && result.status !== 0) {
      return { ok: false, reason: `${pagerCommand} exited with status ${result.status}` };
    }
    return { ok: true };
  } finally {
    stream.write("\u001b[?1049h\u001b[2J\u001b[H");
  }
}

function findLastItemField(
  timeline: TimelineEntry[],
  predicate: (entry: TimelineEntry) => boolean,
  field: "text" | "command" | "output",
): string | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index]!;
    if (!predicate(entry)) continue;
    const value = entry.item?.[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}
