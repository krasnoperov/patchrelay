import type { QueuedTurnInputRecord, ThreadEventRecord } from "./types.ts";

export interface StageTurnInputStore {
  listPendingTurnInputs(stageRunId: number): QueuedTurnInputRecord[];
  setPendingTurnInputRouting(id: number, threadId: string, turnId: string): void;
  markTurnInputDelivered(id: number): void;
}

export interface StageTurnInputStoreProvider {
  stageEvents: StageTurnInputStore;
}

export interface StageEventQueryStore extends StageTurnInputStore {
  listThreadEvents(stageRunId: number): ThreadEventRecord[];
  saveThreadEvent(params: { stageRunId: number; threadId: string; turnId?: string; method: string; eventJson: string }): number;
  enqueueTurnInput(params: { stageRunId: number; threadId?: string; turnId?: string; source: string; body: string }): number;
}

export interface StageEventQueryStoreProvider {
  stageEvents: StageEventQueryStore;
}
