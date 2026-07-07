import type { RunType } from "./run-type.ts";
import type { RunContext } from "./run-context.ts";

export interface WorkflowRunIntent {
  kind: "run";
  runType: RunType;
  context?: RunContext | undefined;
}

export function workflowRunIntent(runType: RunType, context?: RunContext | undefined): WorkflowRunIntent {
  return {
    kind: "run",
    runType,
    ...(context ? { context } : {}),
  };
}
