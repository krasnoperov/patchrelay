import type { ThreadEventRecord } from "./types.ts";

// Thread event logs are primarily observability data used for inspection and reporting.
export interface StageEventLogStore {
  listThreadEvents(stageRunId: number): ThreadEventRecord[];
  saveThreadEvent(params: { stageRunId: number; threadId: string; turnId?: string; method: string; eventJson: string }): number;
}

export interface StageEventLogStoreProvider {
  stageEvents: StageEventLogStore;
}
