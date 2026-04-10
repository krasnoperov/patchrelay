export interface TimerApi<T> {
  setTimeout(callback: () => void, delayMs: number): T;
  clearTimeout(timer: T): void;
}

export interface TransientStatusController<T> {
  timer: T | null;
}

export const defaultTimerApi: TimerApi<ReturnType<typeof setTimeout>> = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer);
  },
};

export function showTransientStatus<T>(
  controller: TransientStatusController<T>,
  message: string,
  setStatus: (message: string | null) => void,
  timers: TimerApi<T>,
  delayMs = 3_000,
): void {
  setStatus(message);
  if (controller.timer !== null) {
    timers.clearTimeout(controller.timer);
  }
  controller.timer = timers.setTimeout(() => {
    controller.timer = null;
    setStatus(null);
  }, delayMs);
}

export function clearTransientStatus<T>(
  controller: TransientStatusController<T>,
  timers: TimerApi<T>,
): void {
  if (controller.timer !== null) {
    timers.clearTimeout(controller.timer);
    controller.timer = null;
  }
}
