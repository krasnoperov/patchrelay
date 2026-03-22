import type { RunType } from "./factory-state.ts";

export interface RunLaunchPlan {
  branchName: string;
  worktreePath: string;
  prompt: string;
  runType: RunType;
}

export interface CodexThreadSummary {
  id: string;
  preview: string;
  cwd: string;
  status: string;
  path?: string | null;
  turns: CodexTurnSummary[];
}

export interface CodexTurnSummary {
  id: string;
  status: string;
  error?: {
    message: string;
  } | null;
  items: CodexThreadItem[];
}

export type CodexThreadItem =
  | { type: "userMessage"; id: string; content: unknown[] }
  | { type: "agentMessage"; id: string; text: string; phase?: string | null }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: string;
      aggregatedOutput?: string | null;
      exitCode?: number | null;
      durationMs?: number | null;
    }
  | { type: "fileChange"; id: string; status: string; changes: Array<Record<string, unknown>> }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string; durationMs?: number | null }
  | { type: "dynamicToolCall"; id: string; tool: string; status: string; durationMs?: number | null }
  | { type: string; id: string; [key: string]: unknown };

export interface StageReport {
  issueKey?: string | undefined;
  runType: string;
  status: string;
  threadId?: string | undefined;
  parentThreadId?: string | undefined;
  turnId?: string | undefined;
  prompt: string;
  assistantMessages: string[];
  plans: string[];
  reasoning: string[];
  commands: Array<{
    command: string;
    cwd: string;
    status: string;
    exitCode?: number | null;
    durationMs?: number | null;
  }>;
  fileChanges: Array<Record<string, unknown>>;
  toolCalls: Array<{
    type: string;
    name: string;
    status: string;
    durationMs?: number | null;
  }>;
  eventCounts: Record<string, number>;
}
