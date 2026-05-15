/**
 * Bounded-concurrency gate for review executions. Callers `acquire()` a slot
 * and MUST invoke the returned `release` function exactly once in a `finally`
 * block — otherwise the slot leaks and parallelism degrades over time.
 *
 * No fairness guarantees: waiters resume in FIFO order strictly because the
 * implementation uses a plain array; nothing depends on this.
 */
export class ReviewSemaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly capacity: number,
    private readonly onCountChange?: (inFlight: number) => void,
  ) {}

  get inFlightCount(): number {
    return this.inFlight;
  }

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.capacity) {
      this.inFlight += 1;
      this.onCountChange?.(this.inFlight);
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight += 1;
        this.onCountChange?.(this.inFlight);
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.inFlight -= 1;
    this.onCountChange?.(this.inFlight);
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }
}
