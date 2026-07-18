export type ReviewHeadStabilityWait = (delayMs: number, signal: AbortSignal) => Promise<void>;

/** Wait outside the review semaphore, resolving early when a newer head aborts the worker. */
export const waitForReviewHeadStability: ReviewHeadStabilityWait = async (delayMs, signal) => {
  if (delayMs <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }

    signal.addEventListener("abort", finish, { once: true });
  });
};
