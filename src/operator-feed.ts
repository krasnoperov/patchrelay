import type { WorkflowStage } from "./types.ts";

export type OperatorFeedEventLevel = "info" | "warn" | "error";
export type OperatorFeedEventKind = "service" | "webhook" | "agent" | "comment" | "stage" | "turn" | "workflow" | "hook";

export interface OperatorFeedQuery {
  limit?: number;
  afterId?: number;
  issueKey?: string;
  projectId?: string;
  kind?: OperatorFeedEventKind;
  stage?: WorkflowStage;
  status?: string;
  workflowId?: string;
}

export interface OperatorFeedEvent {
  id: number;
  at: string;
  level: OperatorFeedEventLevel;
  kind: OperatorFeedEventKind;
  summary: string;
  detail?: string | undefined;
  issueKey?: string | undefined;
  projectId?: string | undefined;
  stage?: WorkflowStage | undefined;
  status?: string | undefined;
  workflowId?: string | undefined;
  nextStage?: WorkflowStage | undefined;
}

type OperatorFeedListener = (event: OperatorFeedEvent) => void;
type OperatorFeedDraft = Omit<OperatorFeedEvent, "id" | "at"> & { at?: string };

interface OperatorFeedStoreLike {
  save(event: Omit<OperatorFeedEvent, "id"> & { id?: number }): OperatorFeedEvent;
  list(options?: OperatorFeedQuery): OperatorFeedEvent[];
}

export class OperatorEventFeed {
  private readonly persistedFallbackEvents: OperatorFeedEvent[] = [];
  private readonly listeners = new Set<OperatorFeedListener>();
  private nextFallbackId = -1;

  constructor(
    private readonly store?: OperatorFeedStoreLike,
    private readonly maxEvents = 500,
  ) {}

  publish(event: OperatorFeedDraft): OperatorFeedEvent {
    const fullEvent = this.persist(event);
    for (const listener of this.listeners) {
      listener(fullEvent);
    }
    return fullEvent;
  }

  list(options?: OperatorFeedQuery): OperatorFeedEvent[] {
    const persisted = this.store?.list(options) ?? [];
    const fallback = this.listFallback(options);
    const combined = [...persisted, ...fallback].sort(compareFeedEvents);
    const limit = options?.limit ?? 50;
    return combined.slice(Math.max(0, combined.length - limit));
  }

  subscribe(listener: OperatorFeedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private persist(event: OperatorFeedDraft): OperatorFeedEvent {
    const normalizedEvent = {
      at: event.at ?? new Date().toISOString(),
      level: event.level,
      kind: event.kind,
      summary: event.summary,
      ...(event.detail ? { detail: event.detail } : {}),
      ...(event.issueKey ? { issueKey: event.issueKey } : {}),
      ...(event.projectId ? { projectId: event.projectId } : {}),
      ...(event.stage ? { stage: event.stage } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.workflowId ? { workflowId: event.workflowId } : {}),
      ...(event.nextStage ? { nextStage: event.nextStage } : {}),
    };

    if (!this.store) {
      return this.pushFallbackEvent(normalizedEvent);
    }

    try {
      return this.store.save(normalizedEvent);
    } catch {
      return this.pushFallbackEvent(normalizedEvent);
    }
  }

  private pushFallbackEvent(event: Omit<OperatorFeedEvent, "id">): OperatorFeedEvent {
    const fullEvent: OperatorFeedEvent = {
      id: this.nextFallbackId,
      ...event,
    };
    this.nextFallbackId -= 1;
    this.persistedFallbackEvents.push(fullEvent);
    if (this.persistedFallbackEvents.length > this.maxEvents) {
      this.persistedFallbackEvents.shift();
    }
    return fullEvent;
  }

  private listFallback(options?: OperatorFeedQuery): OperatorFeedEvent[] {
    return this.persistedFallbackEvents.filter((event) => matchesOperatorFeedEvent(event, options));
  }
}

export function matchesOperatorFeedEvent(event: OperatorFeedEvent, options?: OperatorFeedQuery): boolean {
  if (!options) {
    return true;
  }
  if (options.afterId !== undefined && event.id <= options.afterId) {
    return false;
  }
  if (options.issueKey && event.issueKey !== options.issueKey) {
    return false;
  }
  if (options.projectId && event.projectId !== options.projectId) {
    return false;
  }
  if (options.kind && event.kind !== options.kind) {
    return false;
  }
  if (options.stage && event.stage !== options.stage) {
    return false;
  }
  if (options.status && event.status !== options.status) {
    return false;
  }
  if (options.workflowId && event.workflowId !== options.workflowId) {
    return false;
  }
  return true;
}

function compareFeedEvents(left: OperatorFeedEvent, right: OperatorFeedEvent): number {
  if (left.at !== right.at) {
    return left.at.localeCompare(right.at);
  }
  return left.id - right.id;
}
