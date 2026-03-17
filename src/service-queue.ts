import type { Logger } from "pino";

export class SerialWorkQueue<T> {
  private readonly items: T[] = [];
  private readonly queuedKeys = new Set<string>();
  private pending = false;

  constructor(
    private readonly onDequeue: (item: T) => Promise<void>,
    private readonly logger: Logger,
    private readonly getKey?: (item: T) => string,
  ) {}

  enqueue(item: T, options?: { priority?: boolean }): void {
    const key = this.getKey?.(item);
    if (key && this.queuedKeys.has(key)) {
      return;
    }

    if (options?.priority) {
      this.items.unshift(item);
    } else {
      this.items.push(item);
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

  private async drain(): Promise<void> {
    while (this.items.length > 0) {
      const next = this.items.shift();
      if (next === undefined) {
        continue;
      }

      const key = this.getKey?.(next);
      if (key) {
        this.queuedKeys.delete(key);
      }

      try {
        await this.onDequeue(next);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error({ item: next, error: err.message, stack: err.stack }, "Queue item processing failed");
      }
    }

    this.pending = false;
  }
}
