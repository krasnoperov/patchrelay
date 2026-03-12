import type { QueuedTurnInputRecord, ThreadEventRecord } from "./types.ts";

// Queued turn inputs are a compatibility mirror for operator visibility during the
// ledger cutover. Active delivery correctness should come from obligations instead.
export interface StageTurnInputStore {
  enqueueTurnInput(params: { stageRunId: number; threadId?: string; turnId?: string; source: string; body: string }): number;
  listPendingTurnInputs(stageRunId: number): QueuedTurnInputRecord[];
  setPendingTurnInputRouting(id: number, threadId: string, turnId: string): void;
  markTurnInputDelivered(id: number): void;
}

export interface StageTurnInputStoreProvider {
  stageEvents: StageTurnInputStore;
}

// Thread event logs are primarily observability data used for inspection and reporting.
export interface StageEventLogStore {
  listThreadEvents(stageRunId: number): ThreadEventRecord[];
  saveThreadEvent(params: { stageRunId: number; threadId: string; turnId?: string; method: string; eventJson: string }): number;
}

export interface StageEventLogStoreProvider {
  stageEvents: StageEventLogStore;
}

export interface StageEventStore extends StageTurnInputStore, StageEventLogStore {}

export interface StageEventStoreProvider {
  stageEvents: StageEventStore;
}
