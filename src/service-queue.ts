import type { Logger } from "pino";

interface QueueEntry<T> {
  item: T;
  attempt: number;
}

export interface SerialWorkQueueRetryDecision {
  delayMs: number;
}

export interface SerialWorkQueueOptions<T> {
  retryOnError?: (error: Error, item: T, attempt: number) => SerialWorkQueueRetryDecision | undefined;
}

export class SerialWorkQueue<T> {
  private readonly items: Array<QueueEntry<T>> = [];
  private readonly queuedKeys = new Set<string>();
  private pending = false;

  constructor(
    private readonly onDequeue: (item: T) => Promise<void>,
    private readonly logger: Logger,
    private readonly getKey?: (item: T) => string,
    private readonly options: SerialWorkQueueOptions<T> = {},
  ) {}

  enqueue(item: T, options?: { priority?: boolean }): void {
    this.enqueueEntry({ item, attempt: 0 }, options);
  }

  size(): number {
    return this.items.length;
  }

  private enqueueEntry(entry: QueueEntry<T>, options?: { priority?: boolean }): void {
    const { item } = entry;
    const key = this.getKey?.(item);
    if (key && this.queuedKeys.has(key)) {
      return;
    }

    if (options?.priority) {
      this.items.unshift(entry);
    } else {
      this.items.push(entry);
    }
    if (key) {
      this.queuedKeys.add(key);
    }

    if (!this.pending) {
      this.pending = true;
      queueMicrotask(() => {
        void this.drain();
      });
    }
  }

  private scheduleRetry(entry: QueueEntry<T>, delayMs: number): void {
    const key = this.getKey?.(entry.item);
    if (key && this.queuedKeys.has(key)) {
      return;
    }
    if (key) {
      this.queuedKeys.add(key);
    }
    const timer = setTimeout(() => {
      if (key) {
        this.queuedKeys.delete(key);
      }
      this.enqueueEntry(entry);
    }, delayMs);
    timer.unref?.();
  }

  private async drain(): Promise<void> {
    while (this.items.length > 0) {
      const entry = this.items.shift();
      if (entry === undefined) {
        continue;
      }

      const key = this.getKey?.(entry.item);
      if (key) {
        this.queuedKeys.delete(key);
      }

      try {
        await this.onDequeue(entry.item);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const nextAttempt = entry.attempt + 1;
        const retry = this.options.retryOnError?.(err, entry.item, nextAttempt);
        if (retry) {
          this.logger.warn(
            { item: entry.item, error: err.message, attempt: nextAttempt, retryDelayMs: retry.delayMs },
            "Queue item processing failed; retrying",
          );
          this.scheduleRetry({ item: entry.item, attempt: nextAttempt }, retry.delayMs);
          continue;
        }
        this.logger.error({ item: entry.item, error: err.message, stack: err.stack }, "Queue item processing failed");
      }
    }

    this.pending = false;
  }
}
